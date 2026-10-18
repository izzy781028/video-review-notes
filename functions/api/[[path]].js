// Owner API. Reachable only through Cloudflare Access, and every request's Access JWT is verified again here.
import { HttpError, json, handle, body, randomId } from '../../lib/http.js';
import { db, getConfig, setKv, getKv, DEFAULT_CONFIG } from '../../lib/db.js';
import { ownerEmail } from '../../lib/auth.js';
import { folderId, listVideos, videoInFolder, streamVideo } from '../../lib/google.js';
import { transcribe, polish } from '../../lib/ai.js';
import { listNotes, putNote, deleteNote, getVideo, patchVideo, STATUSES, usedToday, addAllowance, dailyLimit } from '../../lib/core.js';

const OWNER = { author: 'owner' };

export const onRequest = handle(async ({ request, env, params, waitUntil }) => {
  const url = new URL(request.url);
  const path = '/' + [].concat(params.path || []).join('/');
  const method = request.method;
  const email = await ownerEmail(request, env);
  const d = await db(env);
  let m;

  if (path === '/me' && method === 'GET')
    return json({ role: 'owner', email, config: await getConfig(d), drive: !!folderId(env), limit: dailyLimit(env) });

  if (path === '/config' && method === 'PUT') {
    const input = await body(request), config = await getConfig(d);
    for (const k of Object.keys(DEFAULT_CONFIG)) if (k in input) config[k] = typeof DEFAULT_CONFIG[k] === 'boolean' ? !!input[k] : String(input[k]).slice(0, 20000);
    await setKv(d, 'config', config);
    return json({ config });
  }

  // Drive folder listing, with note counts, new guest notes since the owner last looked, and review status.
  if (path === '/videos' && method === 'GET') {
    const files = await listVideos(env);
    const seen = await getKv(d, 'seen', {});
    const { results } = await d.prepare('SELECT video, author, updated FROM notes').all();
    const { results: infos } = await d.prepare("SELECT k, v FROM kv WHERE k LIKE 'video:%'").all();
    const status = Object.fromEntries(infos.map(r => [r.k.slice(6), JSON.parse(r.v).status]));
    for (const f of files) {
      const rows = results.filter(r => r.video === f.id);
      f.notes = rows.length;
      f.fresh = rows.filter(r => r.author !== 'owner' && r.updated > (seen[f.id] || 0)).length;
      f.status = status[f.id] || 'review';
    }
    return json({ files });
  }

  if ((m = path.match(/^\/videos\/([\w-]+)\/media$/))) {
    await videoInFolder(env, m[1]);
    return streamVideo(env, m[1], request);
  }

  if ((m = path.match(/^\/videos\/([\w-]+)$/))) {
    const id = m[1];
    if (method === 'GET') {
      const meta = await videoInFolder(env, id);
      const seen = await getKv(d, 'seen', {});
      seen[id] = Date.now();
      await setKv(d, 'seen', seen);
      return json({ id, name: meta.name, info: await getVideo(d, id), notes: await listNotes(d, id) });
    }
    if (method === 'PATCH') {
      const input = await body(request), patch = {};
      if (input.fps) patch.fps = String(input.fps).slice(0, 10);
      if (input.startTc) patch.startTc = String(input.startTc).slice(0, 12);
      if (input.status in STATUSES) Object.assign(patch, { status: input.status, statusBy: '你', statusAt: Date.now() });
      return json({ info: await patchVideo(d, id, patch) });
    }
  }

  if ((m = path.match(/^\/videos\/([\w-]+)\/notes$/)) && method === 'GET') return json({ notes: await listNotes(d, m[1]) });
  if ((m = path.match(/^\/videos\/([\w-]+)\/notes\/([\w-]+)$/))) {
    if (method === 'PUT') { await putNote(d, m[1], m[2], await body(request), OWNER); return json({ ok: true }); }
    if (method === 'DELETE') { await deleteNote(d, m[1], m[2], OWNER); return json({ ok: true }); }
  }

  // ---------- share links ----------
  if ((m = path.match(/^\/videos\/([\w-]+)\/shares$/))) {
    const video = m[1];
    if (method === 'GET') {
      const { results } = await d.prepare(`SELECT s.*, (SELECT COUNT(*) FROM opens o WHERE o.share = s.id) AS opens
        FROM shares s WHERE s.video = ? AND s.revoked = 0 ORDER BY s.created DESC`).bind(video).all();
      const shares = [];
      for (const s of results) {
        const last = await d.prepare('SELECT at, ua, place FROM opens WHERE share = ? ORDER BY at DESC LIMIT 5').bind(s.id).all();
        shares.push({ id: s.id, label: s.label, token: s.token, pin: s.pin, lockDevice: !!s.lock_device, created: s.created,
          expires: s.expires, opens: s.opens, recent: last.results, used: await usedToday(d, s.id) });
      }
      return json({ shares, limit: dailyLimit(env) });
    }
    if (method === 'POST') {
      const meta = await videoInFolder(env, video);
      const input = await body(request);
      const label = String(input.label || '').trim().slice(0, 40);
      if (!label) throw new HttpError(400, '請填對方的名字');
      const days = Math.min(90, Math.max(1, +input.days || 14));
      const share = { id: randomId(9), token: randomId(24), label, pin: input.pin ? String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, '0') : null,
        lock: input.lockDevice ? 1 : 0, created: Date.now(), expires: Date.now() + days * 86400e3 };
      await d.prepare(`INSERT INTO shares (id, token, video, video_name, label, pin, lock_device, created, expires)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(share.id, share.token, video, meta.name, label, share.pin, share.lock, share.created, share.expires).run();
      return json({ id: share.id, token: share.token, pin: share.pin, expires: share.expires });
    }
  }
  if ((m = path.match(/^\/shares\/([\w-]+)$/)) && method === 'DELETE') {
    await d.prepare('UPDATE shares SET revoked = 1 WHERE id = ?').bind(m[1]).run();
    return json({ ok: true });
  }
  if ((m = path.match(/^\/shares\/([\w-]+)\/more$/)) && method === 'POST') {
    await addAllowance(d, m[1], dailyLimit(env));
    return json({ ok: true });
  }

  // ---------- notifications ----------
  if (path === '/alerts' && method === 'GET') {
    const { results } = await d.prepare('SELECT id, at, kind, share, text FROM alerts WHERE seen = 0 ORDER BY at DESC LIMIT 20').all();
    return json({ alerts: results });
  }
  if (path === '/alerts/seen' && method === 'POST') {
    await d.prepare('UPDATE alerts SET seen = 1 WHERE seen = 0').run();
    return json({ ok: true });
  }

  // ---------- speech and AI (owner: no daily cap) ----------
  if (path === '/stt' && method === 'POST') {
    const form = await request.formData(), config = await getConfig(d);
    return json({ text: await transcribe(env, form.get('file'), config.terms.split('\n').map(s => s.trim()).filter(Boolean)) });
  }
  if (path === '/polish' && method === 'POST')
    return json({ text: await polish(env, await getConfig(d), await body(request)) });

  throw new HttpError(404, '找不到這個功能');
});
