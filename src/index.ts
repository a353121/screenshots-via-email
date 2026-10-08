import PostalMime from 'postal-mime';

/* ================= types ================= */

interface ForwardableEmailMessage {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
  rawSize: number;
}

interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

interface Env {
  SCREENSHOT_API_BASE: string;
  BREVO_API_KEY: string;
  BREVO_FROM_EMAIL: string;
  SCREENSHOT_API_TOKEN?: string;
}

interface ScreenshotOptions {
  url: string;
  format?: 'png' | 'jpg' | 'jpeg' | 'webp' | 'pdf';
  mode?: 'viewport' | 'fullPage' | 'fullPageChunks' | 'element' | 'region' | 'multiDevice';
  device?: string;
  width?: number;
  height?: number;
  selector?: string;
  selectors?: string[];
  region?: { x: number; y: number; width: number; height: number };
  chunkPreset?: string;
  chunkOverlap?: number;
  chunkOutput?: 'separate' | 'stitched';
  chunkFormat?: 'png' | 'jpg' | 'jpeg' | 'webp' | 'pdf';
  delivery?: 'json' | 'zip';
  wait?: number;
  quality?: number;
  css?: string;
  hide?: string[];
  remove?: string[];
  autoScroll?: boolean;
  inspect?: boolean;
  inspectOnly?: boolean;
  inspectMode?: 'interactive' | 'all';
  allowScript?: boolean;
  actions?: any[];
  auth?: any;
  headers?: Record<string, string>;
  waitFor?: any;
  devices?: Array<string | { device: string; format?: string }>;
}

/* ================= config ================= */

const CONFIG = {
  FETCH_TIMEOUT: 300_000, // 5 minutes
  BASE64_CHUNK_SIZE: 0x8000,
  MAX_EMAIL_SIZE: 10 * 1024 * 1024,
  MAX_BREVO_BASE64_CHARS: 9_500_000,
} as const;

/* ================= worker ================= */

export default {
  async fetch() {
    return new Response('Screenshot via Email - Email-only worker', { status: 200 });
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const reqId = crypto.randomUUID();
    const log = (...a: any[]) => console.log(`[${reqId}]`, ...a);

    try {
      log('📨 Email received');

      if (!env.BREVO_API_KEY || !env.BREVO_FROM_EMAIL) {
        throw new Error('Missing env vars');
      }

      if (message.rawSize > CONFIG.MAX_EMAIL_SIZE) {
        throw new Error('Email too large');
      }

      const raw = await readStream(message.raw);
      const parser = new PostalMime();
      const email = await parser.parse(raw);

      const subject = (email.subject || '').trim();
      const from = extractEmail(email.from?.address || message.from);

      const body = email.text || stripHtml(email.html || '');

      const url = extractUrl(body);
      if (!url) {
        ctx.waitUntil(sendBrevo({
          env,
          to: from,
          subject: subject || 'Screenshot Request',
          text: 'No URL found in your email. Please include a URL in the email body.',
        }));
        return;
      }

      const normalized = normalizeUrl(url);
      if (!normalized || isPrivateHost(normalized.hostname)) {
        ctx.waitUntil(sendBrevo({
          env,
          to: from,
          subject: subject || 'Screenshot Request',
          text: 'The provided URL is invalid or not allowed.',
        }));
        return;
      }

      const options = parseOptions(subject, body);

      ctx.waitUntil(
        safeBackgroundJob(
          processScreenshotAndSend({
            env,
            from,
            subject,
            normalized,
            options,
            reqId,
          }),
          env,
          from,
          subject
        )
      );
    } catch (err) {
      log('🔥 Worker error', err);
    }
  },
};

/* ================= background ================= */

async function safeBackgroundJob(
  job: Promise<void>,
  env: Env,
  to: string,
  subject: string
) {
  try {
    await job;
  } catch (err) {
    console.error('💥 Background failure', err);
    await sendBrevo({
      env,
      to,
      subject: subject || 'Screenshot Request',
      text: 'Screenshot failed or timed out. Please check your request and try again.',
    });
  }
}
async function processScreenshotAndSend({
  env,
  from,
  subject,
  normalized,
  options,
  reqId,
}: {
  env: Env;
  from: string;
  subject: string;
  normalized: URL;
  options: ScreenshotOptions;
  reqId: string;
}) {
  const log = (...a: any[]) => console.log(`[${reqId}]`, ...a);
  log('📸 Screenshot start');

  const apiBase = (env.SCREENSHOT_API_BASE || "https://vercel-screenshotter-samweiss.vercel.app").replace(/\/$/, '');
  const screenshotUrl = `${apiBase}/api`;

  const payload = buildPayload(normalized.toString(), options);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);

  let res: Response;
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Screenshot-via-Email/2.0',
    };
    if (env.SCREENSHOT_API_TOKEN) {
      headers['Authorization'] = `Bearer ${env.SCREENSHOT_API_TOKEN}`;
    }
    res = await fetch(screenshotUrl, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(payload),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Screenshot API failed ${res.status}: ${body}`);
  }

  const contentType = res.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json() as any;
    await handleJsonResponse(env, from, subject, normalized, options, data);
    log('✅ Screenshot email sent (JSON)');
    return;
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new Error('Screenshot returned 0 bytes');
  }
  const base64 = arrayBufferToBase64(buffer);

  if (base64.length > CONFIG.MAX_BREVO_BASE64_CHARS) {
    await sendBrevo({
      env,
      to: from,
      subject: subject || 'Screenshot',
      text: `Screenshot too large to email. Try smaller viewport or mobile.\n\nURL: ${normalized}`,
    });
    return;
  }

  const ext = getExtensionFromFormat(options.format);
  await sendBrevo({
    env,
    to: from,
    subject: subject || 'Screenshot',
    text: `Here is your screenshot.\n\nURL: ${normalized}\nMode: ${options.mode || 'default'}\nFormat: ${options.format || 'png'}`,
    attachment: {
      content: base64,
      name: `screenshot-${Date.now()}.${ext}`,
      type: contentType.includes('image/') ? contentType : contentType.includes('pdf') ? 'application/pdf' : contentType.includes('zip') ? 'application/zip' : `image/${ext}`,
    },
  });
  log('✅ Screenshot email sent');
}

async function handleJsonResponse(
  env: Env,
  from: string,
  subject: string,
  normalized: URL,
  options: ScreenshotOptions,
  data: any
) {
  if (data.error) {
    throw new Error(`API error: ${JSON.stringify(data.error)}`);
  }

  if (data.chunks && Array.isArray(data.chunks)) {
    for (let i = 0; i < data.chunks.length; i++) {
      const chunk = data.chunks[i];
      if (chunk.data && chunk.data.length <= CONFIG.MAX_BREVO_BASE64_CHARS) {
        const mime = chunk.mimeType || `image/${getExtensionFromFormat(options.format)}`;
        const ext = (chunk.filename?.split('.').pop()) || getExtensionFromFormat(options.format);
        await sendBrevo({
          env,
          to: from,
          subject: subject || 'Screenshot',
          text: `Here is your screenshot.\n\nURL: ${normalized}\nChunk ${i + 1}/${data.chunks.length}`,
          attachment: {
            content: chunk.data,
            name: chunk.filename || `screenshot-${i + 1}.${ext}`,
            type: mime,
          },
        });
      }
    }
    return;
  }

  if (data.captures && Array.isArray(data.captures)) {
    for (let i = 0; i < data.captures.length; i++) {
      const cap = data.captures[i];
      if (cap.data && cap.data.length <= CONFIG.MAX_BREVO_BASE64_CHARS) {
        const mime = cap.mimeType || `image/${getExtensionFromFormat(options.format)}`;
        const ext = getExtensionFromFormat(options.format);
        await sendBrevo({
          env,
          to: from,
          subject: subject || `Screenshot (${cap.device})`,
          text: `Here is your screenshot.\n\nURL: ${normalized}\nDevice: ${cap.device}`,
          attachment: {
            content: cap.data,
            name: `screenshot-${cap.device}-${Date.now()}.${ext}`,
            type: mime,
          },
        });
      }
    }
    return;
  }

  if (data.image?.data) {
    const base64 = data.image.data;
    if (base64.length <= CONFIG.MAX_BREVO_BASE64_CHARS) {
      const mime = data.image.mimeType || `image/${getExtensionFromFormat(options.format)}`;
      const ext = getExtensionFromFormat(options.format);
      await sendBrevo({
        env,
        to: from,
        subject: subject || 'Screenshot',
        text: `Here is your screenshot.\n\nURL: ${normalized}`,
        attachment: {
          content: base64,
          name: `screenshot-${Date.now()}.${ext}`,
          type: mime,
        },
      });
    }
    return;
  }

  if (data.document?.data) {
    const base64 = data.document.data;
    if (base64.length <= CONFIG.MAX_BREVO_BASE64_CHARS) {
      await sendBrevo({
        env,
        to: from,
        subject: subject || 'Screenshot',
        text: `Here is your PDF.\n\nURL: ${normalized}`,
        attachment: {
          content: base64,
          name: `screenshot-${Date.now()}.pdf`,
          type: 'application/pdf',
        },
      });
    }
    return;
  }
}

function buildPayload(url: string, options: ScreenshotOptions) {
  const payload: any = { url };

  if (options.format) payload.format = options.format;
  if (options.quality !== undefined) payload.quality = options.quality;
  if (options.wait !== undefined) payload.wait = options.wait;
  if (options.css) payload.css = options.css;
  if (options.hide) payload.hide = options.hide;
  if (options.remove) payload.remove = options.remove;
  if (options.allowScript) payload.allowScript = options.allowScript;
  if (options.actions) payload.actions = options.actions;
  if (options.auth) payload.auth = options.auth;
  if (options.headers) payload.headers = options.headers;
  if (options.waitFor) payload.waitFor = options.waitFor;
  if (options.inspect !== undefined) payload.inspect = options.inspect;
  if (options.inspectOnly !== undefined) payload.inspectOnly = options.inspectOnly;
  if (options.inspectMode) payload.inspectMode = options.inspectMode;
  if (options.delivery) payload.delivery = options.delivery;
  if (options.device) payload.deviceType = options.device;

  if (options.mode) {
    const modeMap: Record<string, string> = {
      'fullpage': 'fullPage',
      'full-page': 'fullPage',
      'chunks': 'fullPageChunks',
      'chunk': 'fullPageChunks',
      'element': 'element',
      'region': 'region',
      'multi': 'multiDevice',
      'multidevice': 'multiDevice',
      'viewport': 'viewport',
    };
    payload.capture = payload.capture || {};
    payload.capture.mode = modeMap[options.mode.toLowerCase()] || options.mode;
  }

  if (options.selector) {
    payload.capture = payload.capture || {};
    payload.capture.selector = options.selector;
  }
  if (options.selectors) {
    payload.capture = payload.capture || {};
    payload.capture.selectors = options.selectors;
  }
  if (options.region) {
    payload.capture = payload.capture || {};
    payload.capture.x = options.region.x;
    payload.capture.y = options.region.y;
    payload.capture.width = options.region.width;
    payload.capture.height = options.region.height;
  }
  if (options.width || options.height) {
    payload.viewport = payload.viewport || {};
    if (options.width) payload.viewport.width = options.width;
    if (options.height) payload.viewport.height = options.height;
  }
  if (options.devices) {
    payload.capture = payload.capture || {};
    payload.capture.devices = options.devices;
  }
  if (options.chunkPreset || options.chunkOverlap || options.chunkOutput || options.chunkFormat) {
    payload.chunk = payload.chunk || {};
    if (options.chunkPreset) payload.chunk.preset = options.chunkPreset;
    if (options.chunkOverlap !== undefined) payload.chunk.overlap = options.chunkOverlap;
    if (options.chunkOutput) payload.chunk.output = options.chunkOutput;
    if (options.chunkFormat) payload.chunk.format = options.chunkFormat;
  }
  if (options.autoScroll) {
    payload.prepare = payload.prepare || {};
    payload.prepare.autoScroll = true;
  }
  return payload;
}

function parseOptions(subject: string, body: string): ScreenshotOptions {
  const opts: ScreenshotOptions = {};
  const combined = `${subject}\n${body}`.toLowerCase();

  const deviceMatch = combined.match(/\b(desktop|tablet|mobile|iphone|ipad|pixel|laptop|computer|phone)\b/i);
  if (deviceMatch) {
    const d = deviceMatch[1].toLowerCase();
    const map: Record<string, string> = {
      'desktop': 'desktop-1080p',
      'laptop': 'laptop',
      'computer': 'Computer',
      'tablet': 'ipad',
      'mobile': 'iphone',
      'iphone': 'iphone',
      'ipad': 'ipad',
      'pixel': 'pixel',
      'phone': 'Phone',
    };
    opts.device = map[d] || d;
  }

  if (/\b(full\s*page|fullpage)\b/i.test(combined)) {
    opts.mode = 'fullPage';
  } else if (/\b(chunks?|chunked)\b/i.test(combined)) {
    opts.mode = 'fullPageChunks';
  } else if (/\b(element|selector)\b/i.test(combined)) {
    opts.mode = 'element';
    const sel = body.match(/selector[:\s]+(.+?)(?:\n|$)/i);
    if (sel) opts.selector = sel[1].trim();
  } else if (/\b(region|crop)\b/i.test(combined)) {
    opts.mode = 'region';
  } else if (/\b(multi|multidevice)\b/i.test(combined)) {
    opts.mode = 'multiDevice';
  }

  const fmt = combined.match(/\b(format[:\s]+(png|jpg|jpeg|webp|pdf))\b/i);
  if (fmt) opts.format = fmt[2].toLowerCase() as any;

  const wait = combined.match(/\b(wait[:\s]+(\d+))\b/i);
  if (wait) opts.wait = parseInt(wait[2]);

  const qual = combined.match(/\b(quality[:\s]+(\d+))\b/i);
  if (qual) opts.quality = Math.min(100, Math.max(0, parseInt(qual[2])));

  const wh = combined.match(/\b(\d+)\s*x\s*(\d+)\b/i);
  if (wh) {
    opts.width = parseInt(wh[1]);
    opts.height = parseInt(wh[2]);
  }

  if (/\binspect\b/i.test(combined)) opts.inspect = true;
  if (/\binspect\s*only\b/i.test(combined)) opts.inspectOnly = true;
  if (/\b(auto\s*scroll|lazy)\b/i.test(combined)) opts.autoScroll = true;

  const css = body.match(/css:\n?([\s\S]+?)(?:\n\n|\n[A-Z][A-Z\s]+:|$)/i);
  if (css) opts.css = css[1].trim();

  return opts;
}

function getExtensionFromFormat(fmt?: string) {
  const f = (fmt || 'png').toLowerCase();
  if (f === 'jpg' || f === 'jpeg') return 'jpg';
  if (f === 'webp') return 'webp';
  if (f === 'pdf') return 'pdf';
  return 'png';
}

/* ================= helpers ================= */

async function readStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      size += value.length;
    }
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }

  return result;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CONFIG.BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CONFIG.BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

function extractEmail(input: string) {
  return input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || input;
}

function extractUrl(text: string) {
  return text.match(/https?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/i)?.[0] || null;
}

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, ' ');
}

function normalizeUrl(input: string) {
  try {
    if (!/^[a-z]+:\/\//i.test(input)) input = 'https://' + input;
    const u = new URL(input);
    return ['http:', 'https:'].includes(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

function isPrivateHost(host: string) {
  if (host === 'localhost') return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/* ================= brevo ================= */

async function sendBrevo({
  env,
  to,
  subject,
  text,
  attachment,
}: {
  env: Env;
  to: string;
  subject: string;
  text: string;
  attachment?: { content: string; name: string; type: string };
}) {
  const payload: any = {
    sender: { email: env.BREVO_FROM_EMAIL, name: 'Screenshot Service' },
    to: [{ email: to }],
    subject,
    textContent: text,
  };

  if (attachment?.content) {
    payload.attachment = [attachment];
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo failed ${res.status}: ${body}`);
  }
}
