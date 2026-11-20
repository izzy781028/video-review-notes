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

// when the file's content last changed (an overwrite keeps the file id but moves this); not cached
export async function fileModified(env, id) {
  const meta = await drive(env, `files/${encodeURIComponent(id)}`, { fields: 'modifiedTime' }).catch(() => null);
  return meta?.modifiedTime ? Date.parse(meta.modifiedTime) : null;
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

// Deleting needs the file owner: the service account is only a viewer, and in My Drive only the owner
// can trash a file. The Drive helper (drive-helper/Code.gs) is an Apps Script web app that runs as the
// owner and only trashes videos directly inside the review folder.
export const canTrash = env => !!(env.DRIVE_HELPER_URL && env.DRIVE_HELPER_TOKEN);
// one call to the owner's Apps Script helper; it answers a POST with a redirect to the result, which fetch follows
async function helper(env, what, payload) {
  if (!canTrash(env)) throw new HttpError(400, '尚未設定刪除小幫手（DRIVE_HELPER_URL、DRIVE_HELPER_TOKEN）');
  const r = await fetch(env.DRIVE_HELPER_URL.trim(), {
    method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: env.DRIVE_HELPER_TOKEN, ...payload }),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch {
    throw new HttpError(502, /accounts\.google\.com|ServiceLogin/.test(text)
      ? '刪除小幫手要求登入：部署時「誰可以存取」要選「任何人」'
      : '刪除小幫手沒有回應（請確認 DRIVE_HELPER_URL 是 /exec 結尾的網址）');
  }
  if (!j.ok) throw new HttpError(502, `${what}：` + (j.error === '不支援的動作' ? '刪除小幫手是舊版，請照 docs/SETUP.md 第 6.6 節更新 Code.gs' : j.error || '未知錯誤'));
  return j;
}
export async function trashVideo(env, id) {
  const meta = await videoInFolder(env, id);
  await helper(env, '刪除失敗', { action: 'trash', id });
  metaCache.delete(id);
  return { name: meta.name };
}

// ---------- uploading from the app ----------
// The helper opens a resumable Drive upload as the owner (a service account cannot store files in My Drive);
// the browser then sends 8 MB pieces here and they are passed on to that upload. Its URL never leaves the server.
export async function startUpload(env, d, kv, input) {
  const name = String(input.name || '').trim(), size = Math.round(+input.size);
  if (!/\.(mp4|mov|m4v)$/i.test(name) || /[\/\\]/.test(name) || name.length > 200) throw new HttpError(400, '檔名要是 .mp4、.mov 或 .m4v 結尾');
  if (!(size > 0) || size > 20e9) throw new HttpError(400, '檔案大小不對（上限 20 GB）');
  const replaceId = input.replace ? (await videoInFolder(env, String(input.replace))).id : null;
  const mime = /^video\/[\w.+-]+$/.test(input.mime || '') ? input.mime : /\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4';
  const { session } = await helper(env, '無法開始上傳', { action: 'upload', name, size, mime, replaceId });
  const local = env.GOOGLE_API_BASE && String(session).startsWith(env.GOOGLE_API_BASE); // local tests only
  if (!/^https:\/\/[\w.-]*googleapis\.com\//.test(session || '') && !local) throw new HttpError(502, '無法開始上傳：Drive 沒有給上傳網址');
  const uid = crypto.randomUUID().replace(/-/g, '');
  await kv.set('upload:' + uid, { session, size, name, replaceId, at: Date.now() });
  return { uid, chunk: 8 * 1024 * 1024 };
}
const nextFrom = r => { const m = (r.headers.get('range') || '').match(/bytes=0-(\d+)/); return m ? +m[1] + 1 : 0; };
export async function uploadChunk(kv, uid, start, buf) {
  const u = await kv.get('upload:' + uid, null);
  if (!u) throw new HttpError(404, '找不到這次上傳，請重新上傳');
  const headers = buf ? { 'content-range': `bytes ${start}-${start + buf.byteLength - 1}/${u.size}` } : { 'content-range': `bytes */${u.size}` };
  const r = await fetch(u.session, { method: 'PUT', headers, body: buf || '' });
  if (r.status === 308) return { done: false, next: nextFrom(r) };
  if (r.ok) {
    const f = await r.json().catch(() => ({}));
    await kv.del('upload:' + uid);
    if (f.id) metaCache.delete(f.id);
    return { done: true, file: { id: f.id, name: f.name || u.name }, replaced: !!u.replaceId };
  }
  if (r.status === 404 || r.status === 410) { await kv.del('upload:' + uid); throw new HttpError(410, '上傳已經過期，請重新上傳'); }
  throw new HttpError(502, `Drive 上傳失敗（${r.status}）`);
}
export async function cancelUpload(kv, uid) {
  const u = await kv.get('upload:' + uid, null);
  if (!u) return;
  await fetch(u.session, { method: 'DELETE' }).catch(() => {});
  await kv.del('upload:' + uid);
}
