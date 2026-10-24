// Owner API. Reachable only through Cloudflare Access, and every request's Access JWT is verified again here.
import { HttpError, json, handle, body, randomId } from '../../lib/http.js';
import { db, getConfig, setKv, getKv, DEFAULT_CONFIG } from '../../lib/db.js';
import { ownerEmail } from '../../lib/auth.js';
import { folderId, listVideos, videoInFolder, streamVideo, canTrash, trashVideo } from '../../lib/google.js';
import { transcribe, polish, summarize } from '../../lib/ai.js';
import { listNotes, putNote, deleteNote, getVideo, patchVideo, STATUSES, usedToday, addAllowance, dailyLimit,
  addReply, deleteReply, rememberNames, previousVersions, carryNotes, versionOf } from '../../lib/core.js';

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
    await rememberNames(d, files);
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
    return json({ files, canDelete: canTrash(env) });
  }

  if ((m = path.match(/^\/videos\/([\w-]+)\/media$/))) {
    await videoInFolder(env, m[1]);
    return streamVideo(env, m[1], request);
  }

  if ((m = path.match(/^\/videos\/([\w-]+)$/))) {
    const id = m[1];
    if (method === 'GET') {
      const meta = await videoInFolder(env, id);
      await rememberNames(d, [{ id, name: meta.name }]);
      const seen = await getKv(d, 'seen', {});
      seen[id] = Date.now();
      await setKv(d, 'seen', seen);
      return json({ id, name: meta.name, info: await getVideo(d, id), notes: await listNotes(d, id) });
    }
    if (method === 'PATCH') {
      const input = await body(request), patch = {};
      // auto: detected from the file; otherwise the owner set it by hand
      if (input.fps) Object.assign(patch, { fps: String(input.fps).slice(0, 10), fpsAuto: !!input.auto });
      if (input.startTc) Object.assign(patch, { startTc: String(input.startTc).slice(0, 12), startTcAuto: !!input.auto });
      if (input.status in STATUSES) Object.assign(patch, { status: input.status, statusBy: '你', statusAt: Date.now() });
      return json({ info: await patchVideo(d, id, patch) });
    }
    // to the Drive trash via the owner's helper; notes stay in the database
    if (method === 'DELETE') return json({ ok: true, ...await trashVideo(env, id) });
  }

  if ((m = path.match(/^\/videos\/([\w-]+)\/notes$/)) && method === 'GET') return json({ notes: await listNotes(d, m[1]) });

  // earlier versions of the same video (same name, lower _vN), and carrying their open notes over
  if ((m = path.match(/^\/videos\/([\w-]+)\/versions$/)) && method === 'GET') {
    const meta = await videoInFolder(env, m[1]);
    const inFolder = new Set((await listVideos(env)).map(f => f.id));
    return json({ current: versionOf(meta.name), previous: await previousVersions(d, m[1], meta.name, inFolder) });
  }
  if ((m = path.match(/^\/videos\/([\w-]+)\/carry$/)) && method === 'POST') {
    const meta = await videoInFolder(env, m[1]);
    const { from } = await body(request), names = await getKv(d, 'names', {});
    const a = versionOf(meta.name), b = versionOf(names[from]);
    if (!a || !b || a.family !== b.family || b.v >= a.v) throw new HttpError(400, '只能從同一支影片的舊版本帶入意見');
    const added = await carryNotes(d, m[1], from, names[from]);
    return json({ added, notes: await listNotes(d, m[1]) });
  }

  if ((m = path.match(/^\/videos\/([\w-]+)\/notes\/([\w-]+)\/replies$/)) && method === 'POST') {
    const config = await getConfig(d);
    return json({ reply: await addReply(d, m[1], m[2], (await body(request)).text, { author: 'owner', name: config.reviewer || '你' }) });
  }
  if ((m = path.match(/^\/videos\/([\w-]+)\/replies\/([\w-]+)$/)) && method === 'DELETE') {
    await deleteReply(d, m[1], m[2], OWNER);
    return json({ ok: true });
  }

  // Every open (not done) note across the folder's videos, flagged new when changed after `since`.
  // Screenshots are left out unless thumbs=1, so the local Claude helper gets a small, readable payload.
  if (path === '/inbox' && method === 'GET') {
    const since = +url.searchParams.get('since') || 0, thumbs = url.searchParams.get('thumbs') === '1';
    const files = await listVideos(env);
    const { results: infos } = await d.prepare("SELECT k, v FROM kv WHERE k LIKE 'video:%'").all();
    const info = Object.fromEntries(infos.map(r => [r.k.slice(6), JSON.parse(r.v)]));
    const videos = [];
    for (const f of files) {
      const open = (await listNotes(d, f.id)).filter(n => !n.done && n.decision !== 'reject')
        .sort((a, b) => (a.general ? -1 : a.t) - (b.general ? -1 : b.t))
        .map(({ thumb, ...n }) => ({ ...n, new: n.updated > since, ...(thumbs ? { thumb } : {}) }));
      const i = info[f.id] || {};
      if (open.length || (i.statusAt || 0) > since)
        videos.push({ id: f.id, name: f.name, status: i.status || 'review', statusBy: i.statusBy || null, statusAt: i.statusAt || null,
          fps: i.fps || '29.97', startTc: i.startTc || '00:00:00:00', open: open.length, new: open.filter(n => n.new).length, notes: open });
    }
    return json({ now: Date.now(), since, videos });
  }
  if ((m = path.match(/^\/videos\/([\w-]+)\/notes\/([\w-]+)$/))) {
    if (method === 'PUT') { await putNote(d, m[1], m[2], await body(request), OWNER); return json({ ok: true }); }
    if (method === 'DELETE') { await deleteNote(d, m[1], m[2], OWNER); return json({ ok: true }); }
    if (method === 'PATCH') {
      const note = (await listNotes(d, m[1])).find(n => n.id === m[2]);
      if (!note) throw new HttpError(404, '找不到這則意見');
      const input = await body(request);
      if ('done' in input) note.done = !!input.done;
      // the owner's call on a client's note: accept (as written), adjust (do it differently), reject (won't change)
      if ('decision' in input) {
        if (input.decision && !['accept', 'adjust', 'reject'].includes(input.decision)) throw new HttpError(400, '決定只能是 accept、adjust 或 reject');
        note.decision = input.decision || null;
        note.decisionNote = String(input.decisionNote || '').slice(0, 2000) || null;
      }
      await putNote(d, m[1], m[2], note, OWNER);
      return json({ ok: true, done: note.done, decision: note.decision || null });
    }
  }

  // ---------- share links ----------
  if ((m = path.match(/^\/videos\/([\w-]+)\/shares$/))) {
    const video = m[1];
    if (method === 'GET') {
      // links made for any version of this video (they all follow to the newest one)
      const names = await getKv(d, 'names', {}), me = versionOf(names[video]);
      const ids = [...new Set([video, ...(me ? Object.keys(names).filter(id => versionOf(names[id])?.family === me.family) : [])])];
      const { results } = await d.prepare(`SELECT s.*, (SELECT COUNT(*) FROM opens o WHERE o.share = s.id) AS opens
        FROM shares s WHERE s.video IN (${ids.map(() => '?').join(',')}) AND s.revoked = 0 ORDER BY s.created DESC`).bind(...ids).all();
      const shares = [];
      for (const s of results) {
        const last = await d.prepare('SELECT at, ua, place FROM opens WHERE share = ? ORDER BY at DESC LIMIT 5').bind(s.id).all();
        shares.push({ id: s.id, label: s.label, token: s.token, pin: s.pin, lockDevice: !!s.lock_device, created: s.created,
          madeFor: s.video_name, follows: !!me,
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
  if (path === '/summary' && method === 'POST')
    return json({ summary: await summarize(env, await getConfig(d), await body(request)) });

  throw new HttpError(404, '找不到這個功能');
});
