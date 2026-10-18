// Small helpers shared by every Pages Function.
export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export function handle(fn) {
  return async context => {
    try {
      return await fn(context);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error(err);
      return json({ error: '伺服器錯誤：' + (err.message || err) }, 500);
    }
  };
}

export async function body(request, limit = 3_000_000) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, '資料太大');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, '資料格式錯誤'); }
}

const enc = new TextEncoder();
export const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64urlText = s => b64url(enc.encode(s));
export function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
export const randomId = (bytes = 16) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', enc.encode(s))); }

export function cookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Calendar day in Taiwan, used for the daily usage allowance.
export const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
