import { HttpError, fromB64url } from './http.js';

// The owner reaches the site through Cloudflare Access (email one-time code).
// Access adds a signed JWT to every request; verify it here as well, so a
// request that slips past Access (e.g. a preview deployment URL) gets nothing.
let certs = { at: 0, keys: [] };

const teamUrl = env => {
  const t = (env.ACCESS_TEAM_DOMAIN || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(t) ? t : 'https://' + t;
};

export async function ownerEmail(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !env.OWNER_EMAILS)
    throw new HttpError(500, '尚未設定 ACCESS_TEAM_DOMAIN / ACCESS_AUD / OWNER_EMAILS');
  const jwt = request.headers.get('cf-access-jwt-assertion');
  if (!jwt) throw new HttpError(401, '請先登入');
  const [h, p, s] = jwt.split('.');
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(h)));
    payload = JSON.parse(new TextDecoder().decode(fromB64url(p)));
  } catch { throw new HttpError(401, '登入憑證格式錯誤'); }

  const team = teamUrl(env);
  if (Date.now() - certs.at > 3600e3 || !certs.keys.some(k => k.kid === header.kid)) {
    const r = await fetch(team + '/cdn-cgi/access/certs');
    if (!r.ok) throw new HttpError(500, '無法取得 Cloudflare Access 憑證，請檢查 ACCESS_TEAM_DOMAIN');
    certs = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certs.keys.find(k => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, '登入憑證無效');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!valid || [].concat(payload.aud).indexOf(env.ACCESS_AUD) < 0 || payload.iss !== team || payload.exp * 1000 < Date.now())
    throw new HttpError(401, '登入憑證無效或已過期，請重新整理頁面');

  const email = String(payload.email || '').toLowerCase();
  const owners = env.OWNER_EMAILS.toLowerCase().split(/[\s,;]+/).filter(Boolean);
  if (!owners.includes(email)) throw new HttpError(403, `${email} 沒有擁有者權限`);
  return email;
}
