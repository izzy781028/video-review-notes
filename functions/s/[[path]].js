// Share links for outside reviewers: /s/#t=<token> serves the app in guest mode, /s/api/* is its API.
// Cloudflare Access is bypassed for /s; the share token (plus optional PIN / device lock) is the gate.
import { HttpError, json, handle, body } from '../../lib/http.js';
import { getConfig } from '../../lib/db.js';
import { videoInFolder, streamVideo } from '../../lib/google.js';
import { transcribe, polish } from '../../lib/ai.js';
import { resolveShare, who } from '../../lib/share.js';
import { listNotes, putNote, deleteNote, getVideo, patchVideo, STATUSES, notify, spend, dailyLimit, usedToday, addReply, deleteReply } from '../../lib/core.js';

const forGuest = notes => notes.map(({ decision, decisionNote, carried, origAuthor, ...n }) => n);

const api = handle(async ({ request, env, params, waitUntil }) => {
  const url = new URL(request.url);
  const path = '/' + [].concat(params.path || []).slice(1).join('/');
  const method = request.method;
  const opening = path === '/info';
  const { share, d, setCookies } = await resolveShare(request, env, url, { opening });
  const me = who(share);
  const withCookies = res => { setCookies.forEach(c => res.headers.append('set-cookie', c)); return res; };
  let m;

  if (path === '/info' && method === 'GET') {
    const meta = await videoInFolder(env, share.video);
    const config = await getConfig(d);
    await d.prepare('INSERT INTO opens (share, at, ua, place) VALUES (?, ?, ?, ?)')
      .bind(share.id, Date.now(), (request.headers.get('user-agent') || '').slice(0, 300),
        [request.cf?.city, request.cf?.country].filter(Boolean).join(', ')).run();
    return withCookies(json({
      role: 'guest', name: share.label, expires: share.expires,
      video: { id: share.video, name: meta.name }, info: await getVideo(d, share.video),
      config: { cats: config.cats, autoPolish: config.autoPolish, polishImage: config.polishImage },
      limit: dailyLimit(env), used: await usedToday(d, share.id),
      notes: forGuest(await listNotes(d, share.video, me.author)),
    }));
  }
  if (path === '/media') return withCookies(await streamVideo(env, share.video, request));

  if (path === '/notes' && method === 'GET') return json({ notes: forGuest(await listNotes(d, share.video, me.author)) });
  if ((m = path.match(/^\/notes\/([\w-]+)$/))) {
    if (method === 'PUT') { await putNote(d, share.video, m[1], await body(request), me); return json({ ok: true }); }
    if (method === 'DELETE') { await deleteNote(d, share.video, m[1], me); return json({ ok: true }); }
  }
  if ((m = path.match(/^\/notes\/([\w-]+)\/replies$/)) && method === 'POST') {
    const reply = await addReply(d, share.video, m[1], (await body(request)).text, me);
    waitUntil(notify(d, env, 'reply', `${share.label} 在「${share.video_name}」回覆：${reply.text.slice(0, 60)}`, share.id));
    return json({ reply });
  }
  if ((m = path.match(/^\/replies\/([\w-]+)$/)) && method === 'DELETE') { await deleteReply(d, share.video, m[1], me); return json({ ok: true }); }

  if (path === '/status' && method === 'POST') {
    const { status } = await body(request);
    if (!(status in STATUSES) || status === 'review') throw new HttpError(400, '狀態錯誤');
    const info = await patchVideo(d, share.video, { status, statusBy: share.label, statusAt: Date.now() });
    waitUntil(notify(d, env, 'status', `${share.label} 把「${share.video_name}」標為「${STATUSES[status]}」`, share.id));
    return json({ info });
  }

  if (path === '/stt' && method === 'POST') {
    await spend(d, env, share, waitUntil);
    const form = await request.formData(), config = await getConfig(d);
    return json({ text: await transcribe(env, form.get('file'), config.terms.split('\n').map(s => s.trim()).filter(Boolean)) });
  }
  if (path === '/polish' && method === 'POST') {
    await spend(d, env, share, waitUntil);
    return json({ text: await polish(env, await getConfig(d), await body(request)) });
  }
  throw new HttpError(404, '找不到這個功能');
});

export async function onRequest(context) {
  const segs = [].concat(context.params.path || []);
  if (segs[0] === 'api') return api(context);
  // icons and the manifest are referenced relatively, so /s/icons/... must serve the real files
  if (segs[0] === 'icons' || segs[0] === 'manifest.webmanifest')
    return context.env.ASSETS.fetch(new URL('/' + segs.map(encodeURIComponent).join('/'), context.request.url));
  // Any other /s/... path is the app itself; it switches to guest mode on its own.
  return context.env.ASSETS.fetch(new URL('/', context.request.url));
}
