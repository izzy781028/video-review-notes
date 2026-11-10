import { HttpError, randomId, today } from './http.js';
import { getKv } from './db.js';
import { versionOf } from './core.js';

// Reference images attached to notes. The browser shrinks them first (long side 1600 px), so they fit in D1
// (2 MB per row) without extra storage to set up. A note lists its images as refs: [{ id, w, h }].
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX = 1_800_000;
export const imageId = id => { if (!/^[\w-]{8,64}$/.test(id || '')) throw new HttpError(400, '圖片編號錯誤'); return id; };

export async function saveImage(d, video, author, request) {
  const mime = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!TYPES.includes(mime)) throw new HttpError(415, '只能上傳 JPG、PNG 或 WebP 圖片');
  const data = await request.arrayBuffer();
  if (!data.byteLength) throw new HttpError(400, '沒有收到圖片');
  if (data.byteLength > MAX) throw new HttpError(413, '圖片太大');
  const url = new URL(request.url), dim = k => Math.max(0, Math.min(20000, Math.round(+url.searchParams.get(k) || 0)));
  const id = randomId(16), w = dim('w'), h = dim('h');
  await d.prepare('INSERT INTO images (id, video, author, mime, data, w, h, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, video, author, mime, new Uint8Array(data), w, h, Date.now()).run();
  return { id, w, h };
}

export async function imageResponse(d, id, allowed) {
  const row = await d.prepare('SELECT video, author, mime, data FROM images WHERE id = ?').bind(imageId(id)).first();
  if (!row || (allowed && !(await allowed(row)))) throw new HttpError(404, '找不到這張圖片');
  // D1 hands BLOBs back as an array of byte values
  return new Response(new Uint8Array(row.data), { headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=31536000, immutable' } });
}

export async function deleteImage(d, id, who) {
  const row = await d.prepare('SELECT author FROM images WHERE id = ?').bind(imageId(id)).first();
  if (!row) return;
  if (who.author !== 'owner' && row.author !== who.author) throw new HttpError(403, '只能刪除自己上傳的圖片');
  await d.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
}

// a share link may show images on its video and on earlier versions of it (the client's earlier notes)
export async function inShareFamily(d, share, video) {
  if (video === share.video || video === share.origVideo) return true;
  const names = await getKv(d, 'names', {}), mine = versionOf(share.video_name), theirs = versionOf(names[video] || '');
  return !!(mine && theirs && mine.family === theirs.family);
}

// guests: at most 60 images a day per share link
export async function spendImage(d, share) {
  const row = await d.prepare(`INSERT INTO usage (who, day, n) VALUES (?, ?, 1)
                               ON CONFLICT (who, day) DO UPDATE SET n = n + 1 RETURNING n`).bind('img:' + share.id, today()).first();
  if (row.n > 60) throw new HttpError(429, '今天上傳的參考圖已經到上限（60 張），明天再試，或先用文字描述。');
}

// keep only well-formed refs on a note
export const cleanRefs = refs => Array.isArray(refs)
  ? refs.filter(r => /^[\w-]{8,64}$/.test(r?.id || '')).slice(0, 6).map(r => ({ id: r.id, w: Math.round(+r.w || 0), h: Math.round(+r.h || 0) }))
  : [];
