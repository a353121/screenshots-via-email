import PostalMime from 'postal-mime';

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

const CONFIG = {
  SCREENSHOT_DELAY: 4,
  FETCH_TIMEOUT: 15000,
  BASE64_CHUNK_SIZE: 0x8000,
  MAX_EMAIL_SIZE: 10 * 1024 * 1024,
  MAX_BREVO_BASE64_CHARS: 9_500_000,
} as const;

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    try {
      if (!env.SCREENSHOT_API_BASE || !env.BREVO_API_KEY || !env.BREVO_FROM_EMAIL) {
        throw new Error('Missing env vars');
      }

      if (message.rawSize > CONFIG.MAX_EMAIL_SIZE) {
        throw new Error('Email too large');
      }

      // ---------- Parse MIME ----------
      const raw = await readStream(message.raw);
      const parser = new PostalMime();
      const email = await parser.parse(raw);

      const subject = (email.subject || '').trim();
      const from = extractEmail(email.from?.address || message.from);
      const device = detectDevice(subject);

      const bodyText = email.text || '';
      const bodyHtml = email.html || '';

      const url =
        extractUrl(bodyText) ||
        extractUrl(stripHtml(bodyHtml));

      if (!url) {
        ctx.waitUntil(
          sendBrevo({
            env,
            to: from,
            subject: subject || device,
            text: 'No URL found in your email. Please include a valid link.',
          })
        );
        return;
      }

      const normalized = normalizeUrl(url);
      if (!normalized || isPrivateHost(normalized.hostname)) {
        ctx.waitUntil(
          sendBrevo({
            env,
            to: from,
            subject: subject || device,
            text: 'The provided URL is invalid or not allowed.',
          })
        );
        return;
      }

      // ---------- Screenshot ----------
      const screenshotUrl = new URL(env.SCREENSHOT_API_BASE);
      screenshotUrl.pathname = screenshotUrl.pathname.replace(/\/$/, '') + '/take';
      screenshotUrl.searchParams.set('url', normalized.toString());
      screenshotUrl.searchParams.set('device', device);
      screenshotUrl.searchParams.set('delay', CONFIG.SCREENSHOT_DELAY.toString());
      screenshotUrl.searchParams.set('type', 'jpeg');
      screenshotUrl.searchParams.set('fullPage', 'true');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT);

      const res = await fetch(screenshotUrl.toString(), {
        signal: controller.signal,
        headers: { 'User-Agent': 'CF-Email-Screenshot/1.0' },
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`Screenshot API failed ${res.status}`);
      }

      const imageBuffer = await res.arrayBuffer();
      const imageBase64 = arrayBufferToBase64(imageBuffer);

      if (imageBase64.length > CONFIG.MAX_BREVO_BASE64_CHARS) {
        ctx.waitUntil(
          sendBrevo({
            env,
            to: from,
            subject: subject || device,
            text: 'Screenshot too large to send by email. Try "mobile" or "tablet".',
          })
        );
        return;
      }

      // ---------- Send email ----------
      ctx.waitUntil(
        sendBrevo({
          env,
          to: from,
          subject: subject || device,
          text: `Here is your screenshot.\n\nDevice: ${device}\nURL: ${normalized}`,
          attachment: {
            content: imageBase64,
            name: `screenshot-${device}.jpeg`,
            type: 'image/jpeg',
          },
        })
      );
    } catch (err) {
      console.error('Worker error:', err);
    }
  },
};

/* ---------------- helpers ---------------- */

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
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

function extractEmail(input: string): string {
  const m = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : input;
}

/* 🔁 UPDATED: accepts any reasonable URL */
function extractUrl(text: string): string | null {
  if (!text) return null;

  const patterns = [
    /https?:\/\/[^\s<>"']+/gi,
    /\bwww\.[^\s<>"']+/gi,
    /\b[a-z0-9-]+(\.[a-z0-9-]+)+[^\s<>"']*/gi,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[0].replace(/[.,;:!?]+$/, '');
    }
  }

  return null;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ');
}

function detectDevice(subject: string): 'desktop' | 'tablet' | 'mobile' {
  const m = subject.toLowerCase().match(/\b(desktop|tablet|mobile)\b/);
  return (m?.[1] as any) || 'desktop';
}

/* 🔁 UPDATED: auto-adds https:// */
function normalizeUrl(input: string): URL | null {
  try {
    let url = input.trim();
    if (!/^[a-z]+:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;

    return parsed;
  } catch {
    return null;
  }
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost') return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = m.slice(1).map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31)
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += CONFIG.BASE64_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CONFIG.BASE64_CHUNK_SIZE));
  }
  return btoa(binary);
}

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
    replyTo: { email: env.BREVO_FROM_EMAIL, name: 'Screenshot Service' },
    to: [{ email: to }],
    subject,
    textContent: text,
  };

  if (attachment) payload.attachment = [attachment];

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Brevo failed ${res.status}`);
  }
}
