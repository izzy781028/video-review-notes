import { HttpError, cookies, randomId, sha256 } from './http.js';
import { db, getKv } from './db.js';

// A share link carries a long random token: it opens one video, nothing else.
// Optional extras: a separate 6-digit PIN, and locking the link to the first device that opens it.
// Both are remembered in HttpOnly cookies scoped to /s, so the video stream (which can't send headers) passes too.
export async function resolveShare(request, env, url, { opening = false } = {}) {
  const token = request.headers.get('x-share-token') || url.searchParams.get('t') || '';
  if (!/^[\w-]{20,}$/.test(token)) throw new HttpError(401, '分享連結不完整，請重新複製整段連結。', { code: 'bad_link' });
  const d = await db(env);
  const s = await d.prepare('SELECT * FROM shares WHERE token = ?').bind(token).first();
  if (!s || s.revoked) throw new HttpError(403, '這個分享連結已被取消，請向分享者索取新連結。', { code: 'revoked' });
  if (s.expires < Date.now()) throw new HttpError(403, '這個分享連結已過期，請向分享者索取新連結。', { code: 'expired' });
  // a link follows its video to newer versions (…_v2 → …_v3); opening the link (/info) refreshes which one that is
  s.origVideo = s.video; s.origName = s.video_name;
  const cur = await getKv(d, 'sharecur:' + s.id, null);
  if (cur) { s.video = cur.id; s.video_name = cur.name; }

  const jar = cookies(request), setCookies = [];
  const maxAge = Math.max(60, Math.floor((s.expires - Date.now()) / 1000));
  const cookie = (name, value) => `${name}=${encodeURIComponent(value)}; Path=/s; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

  if (s.lock_device) {
    let dev = jar['vrn_dev_' + s.id];
    if (!s.device) {
      if (!opening) throw new HttpError(403, '請重新打開分享連結。', { code: 'device' });
      dev ||= randomId(16);
      const r = await d.prepare('UPDATE shares SET device = ? WHERE id = ? AND device IS NULL').bind(dev, s.id).run();
      if (!r.meta.changes) throw new HttpError(403, '這個連結已在另一台裝置開啟過，只能在那台裝置上使用。', { code: 'device' });
      s.device = dev;
      setCookies.push(cookie('vrn_dev_' + s.id, dev));
    } else if (dev !== s.device) {
      throw new HttpError(403, '這個連結已在另一台裝置開啟過，只能在那台裝置上使用。如需在這台裝置觀看，請向分享者索取新連結。', { code: 'device' });
    }
  }

  if (s.pin) {
    const okValue = await sha256(`${token}:${s.pin}`);
    if (jar['vrn_pin_' + s.id] !== okValue) {
      if (s.pin_fails >= 10) throw new HttpError(403, '密碼錯誤太多次，這個連結已鎖定，請向分享者索取新連結。', { code: 'locked' });
      const pin = request.headers.get('x-share-pin');
      if (!pin) throw new HttpError(401, '請輸入分享者另外給你的 6 位數密碼。', { code: 'pin' });
      if (pin !== s.pin) {
        await d.prepare('UPDATE shares SET pin_fails = pin_fails + 1 WHERE id = ?').bind(s.id).run();
        throw new HttpError(401, '密碼不正確，請再試一次。', { code: 'pin', wrong: true });
      }
      setCookies.push(cookie('vrn_pin_' + s.id, okValue));
    }
  }
  return { share: s, d, setCookies };
}

export const who = share => ({ author: 'share:' + share.id, name: share.label });
