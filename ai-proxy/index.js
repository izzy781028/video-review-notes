// Relays Anthropic Messages API calls from the Pages app. Needs the PROXY_TOKEN secret;
// the app sends the same value in x-clipnote-proxy (Pages variable AI_PROXY_TOKEN).
const UPSTREAM = 'https://api.anthropic.com';

const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.PROXY_TOKEN) return json({ error: 'forbidden', why: 'PROXY_TOKEN 尚未設定（Worker → Settings → Variables and Secrets）' }, 403);
    if (!same(request.headers.get('x-clipnote-proxy') || url.searchParams.get('token'), env.PROXY_TOKEN))
      return json({ error: 'forbidden', why: '密碼和 PROXY_TOKEN 不一致' }, 403);

    // GET /check?token=… shows which data center this Worker sends requests from
    if (url.pathname === '/check' && request.method === 'GET') {
      const trace = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
      const f = Object.fromEntries(trace.trim().split('\n').map(l => l.split('=')));
      return json({ ok: true, colo: f.colo, loc: f.loc });
    }
    if (request.method !== 'POST' || !url.pathname.startsWith('/v1/messages')) return json({ error: 'not found' }, 404);

    const headers = new Headers();
    for (const [k, v] of request.headers)
      if (k === 'x-api-key' || k === 'content-type' || k === 'accept' || k.startsWith('anthropic-') || k.startsWith('x-stainless-')) headers.set(k, v);
    return fetch(UPSTREAM + url.pathname + url.search, { method: 'POST', headers, body: request.body });
  },
};
