import { HttpError, b64urlText, b64url } from './http.js';

// Drive access with a service account: the folder stays private and is shared
// only with the service account's email. GOOGLE_API_BASE / GOOGLE_TOKEN_URL
// exist only so the functions can be tested against a local mock.
const api = env => (env.GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, '');
let token = { value: '', exp: 0 };

function pemBody(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

async function accessToken(env) {
  if (token.value && token.exp > Date.now() + 60e3) return token.value;
  if (!env.GOOGLE_SERVICE_ACCOUNT) throw new HttpError(500, '尚未設定 GOOGLE_SERVICE_ACCOUNT');
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch { throw new HttpError(500, 'GOOGLE_SERVICE_ACCOUNT 不是有效的 JSON 金鑰'); }
  const now = Math.floor(Date.now() / 1000);
  const tokenUrl = env.GOOGLE_TOKEN_URL || sa.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64urlText(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/drive.readonly', aud: tokenUrl, iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey('pkcs8', pemBody(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const r = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const j = await r.json();
  if (!r.ok) throw new HttpError(500, 'Google 服務帳戶登入失敗：' + (j.error_description || j.error || r.status));
  token = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

export function folderId(env) {
  const v = (env.DRIVE_FOLDER || '').trim();
  const m = v.match(/\/folders\/([\w-]+)/) || v.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : /^[\w-]{10,}$/.test(v) ? v : '';
}

async function drive(env, path, params = {}) {
  const qs = new URLSearchParams({ supportsAllDrives: 'true', ...params });
  const r = await fetch(`${api(env)}/drive/v3/${path}?${qs}`, { headers: { authorization: 'Bearer ' + await accessToken(env) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error?.message || r.status;
    if (r.status === 404) throw new HttpError(404, '找不到檔案或資料夾：請確認 DRIVE_FOLDER 正確，且資料夾已分享給服務帳戶的 Email');
    if (/has not been used|is disabled/i.test(msg)) throw new HttpError(500, 'Google Drive API 尚未啟用');
    throw new HttpError(502, 'Google Drive 錯誤：' + msg);
  }
  return j;
}

// Only the videos directly inside the one configured folder, newest first.
export async function listVideos(env) {
  const folder = folderId(env);
  if (!folder) throw new HttpError(500, '尚未設定 DRIVE_FOLDER');
  const j = await drive(env, 'files', {
    q: `'${folder}' in parents and trashed = false and mimeType contains 'video/'`,
    orderBy: 'modifiedTime desc', pageSize: '200', includeItemsFromAllDrives: 'true',
    fields: 'files(id,name,size,modifiedTime,videoMediaMetadata(durationMillis,width,height))',
  });
  return j.files || [];
}

// Refuse anything outside the configured folder, even for the owner.
const metaCache = new Map();
export async function videoInFolder(env, id) {
  const hit = metaCache.get(id);
  if (hit && hit.at > Date.now() - 600e3) return hit.meta;
  const meta = await drive(env, `files/${encodeURIComponent(id)}`, { fields: 'id,name,mimeType,parents,trashed' });
  if (!meta.parents?.includes(folderId(env)) || meta.trashed || !meta.mimeType?.startsWith('video/'))
    throw new HttpError(404, '這支影片不在指定的資料夾裡');
  metaCache.set(id, { at: Date.now(), meta });
  return meta;
}

// Stream the file to the browser, passing Range through so the player can seek.
export async function streamVideo(env, id, request) {
  const headers = { authorization: 'Bearer ' + await accessToken(env) };
  const range = request.headers.get('range');
  if (range) headers.range = range;
  const r = await fetch(`${api(env)}/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers });
  const out = new Headers({ 'cache-control': 'private, no-store', 'accept-ranges': 'bytes' });
  for (const h of ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']) {
    const v = r.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(r.body, { status: r.status, headers: out });
}
