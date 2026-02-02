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
}

/* ================= config ================= */

const CONFIG = {
  SCREENSHOT_DELAY: 5,
  FETCH_TIMEOUT: 60_000, // ⬅️ safer
  BASE64_CHUNK_SIZE: 0x8000,
  MAX_EMAIL_SIZE: 10 * 1024 * 1024,
  MAX_BREVO_BASE64_CHARS: 9_500_000,
} as const;

/* ================= worker ================= */

export default {
  async fetch() {
    return new Response('Email-only worker', { status: 200 });
  },

  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const reqId = crypto.randomUUID();
    const log = (...a: any[]) => console.log(`[${reqId}]`, ...a);

    try {
      log('📨 Email received');

      if (!env.SCREENSHOT_API_BASE || !env.BREVO_API_KEY || !env.BREVO_FROM_EMAIL) {
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
      const device = detectDevice(subject);

      const body =
        email.text ||
        stripHtml(email.html || '');

      const url = extractUrl(body);
      if (!url) {
        ctx.waitUntil(sendBrevo({
          env,
          to: from,
          subject: subject || device,
          text: 'No URL found in your email.',
        }));
        return;
      }

      const normalized = normalizeUrl(url);
      if (!normalized || isPrivateHost(normalized.hostname)) {
        ctx.waitUntil(sendBrevo({
          env,
          to: from,
          subject: subject || device,
          text: 'The provided URL is invalid or not allowed.',
        }));
        return;
      }

      ctx.waitUntil(
        safeBackgroundJob(
          processScreenshotAndSend({
            env,
            from,
            subject,
            device,
            normalized,
            reqId,
          }),
          env,
          from,
          subject,
          device
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
  subject: string,
  device: string
) {
  try {
    await job;
  } catch (err) {
    console.error('💥 Background failure', err);
    await sendBrevo({
      env,
      to,
      subject: subject || device,
      text: 'Screenshot failed or timed out. Please try again.',
    });
  }
}

async function processScreenshotAndSend({
  env,
  from,
  subject,
  device,
  normalized,
  reqId,
}: {
  env: Env;
  from: string;
  subject: string;
  device: 'desktop' | 'tablet' | 'mobile';
  normalized: URL;
  reqId: string;
}) {
  const log = (...a: any[]) => console.log(`[${reqId}]`, ...a);

  log('📸 Screenshot start');

  const screenshotUrl = new URL(env.SCREENSHOT_API_BASE.replace(/\/$/, '') + '/take');
  screenshotUrl.searchParams.set('url', normalized.toString());
  screenshotUrl.searchParams.set('device', device);
  screenshotUrl.searchParams.set('delay', CONFIG.SCREENSHOT_DELAY.toString());
  screenshotUrl.searchParams.set('type', 'jpeg');
  screenshotUrl.searchParams.set('fullPage', 'true');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);

  let res: Response;
  try {
    res = await fetch(screenshotUrl.toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': 'CF-Email-Screenshot/1.0' },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(`Screenshot API failed ${res.status}`);
  }

  const buffer = await res.arrayBuffer();

  if (buffer.byteLength === 0) {
    throw new Error('Screenshot returned 0 bytes');
  }

  const base64 = arrayBufferToBase64(buffer);

  if (!base64 || base64.length === 0) {
    throw new Error('Base64 conversion failed');
  }

  if (base64.length > CONFIG.MAX_BREVO_BASE64_CHARS) {
    await sendBrevo({
      env,
      to: from,
      subject: subject || device,
      text: 'Screenshot too large to email. Try mobile or tablet.',
    });
    return;
  }

  await sendBrevo({
    env,
    to: from,
    subject: subject || device,
    text: `Here is your screenshot.\n\nDevice: ${device}\nURL: ${normalized}`,
    attachment: {
      content: base64,
      name: `screenshot-${device}.jpeg`,
      type: 'image/jpeg',
    },
  });

  log('✅ Screenshot email sent');
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

function detectDevice(subject: string) {
  return subject.toLowerCase().match(/\b(desktop|tablet|mobile)\b/)?.[1] as any || 'desktop';
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
