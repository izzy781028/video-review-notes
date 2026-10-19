import { HttpError, today, randomId } from './http.js';
import { getKv, setKv } from './db.js';

// ---------- notes (one row per note, so owner and guests never overwrite each other) ----------
const noteId = id => { if (!/^[\w-]{1,64}$/.test(id || '')) throw new HttpError(400, '意見編號錯誤'); return id; };

export async function listNotes(d, video, author) {
  const q = author
    ? d.prepare('SELECT data, author, updated FROM notes WHERE video = ? AND author = ?').bind(video, author)
    : d.prepare('SELECT data, author, updated FROM notes WHERE video = ?').bind(video);
  const { results } = await q.all();
  const { results: rs } = await d.prepare('SELECT id, note, author, by, text, at FROM replies WHERE video = ? ORDER BY at').bind(video).all();
  return results.map(r => {
    const n = JSON.parse(r.data);
    return { ...n, author: r.author, updated: r.updated, replies: rs.filter(x => x.note === n.id).map(({ note, ...x }) => x) };
  });
}

export async function putNote(d, video, id, note, who) {
  noteId(id);
  const ex = await d.prepare('SELECT author, video FROM notes WHERE id = ?').bind(id).first();
  if (ex && (ex.video !== video || (who.author !== 'owner' && ex.author !== who.author)))
    throw new HttpError(403, '只能修改自己的意見');
  const data = { ...note, id };
  delete data.video; delete data.author; delete data.updated; delete data.replies; // replies live in their own table
  if (who.author !== 'owner') {
    data.by = who.name;
    delete data.decision; delete data.decisionNote; delete data.carried; delete data.origAuthor;
    if (ex) {
      const prev = JSON.parse((await d.prepare('SELECT data FROM notes WHERE id = ?').bind(id).first()).data);
      if (prev.decision) { data.decision = prev.decision; data.decisionNote = prev.decisionNote; }
    }
  }
  const text = JSON.stringify(data);
  if (text.length > 1_500_000) throw new HttpError(413, '這則意見太大');
  await d.prepare(`INSERT INTO notes (id, video, author, data, updated) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated = excluded.updated`)
    .bind(id, video, ex?.author || who.author, text, Date.now()).run();
}

export async function deleteNote(d, video, id, who) {
  noteId(id);
  const ex = await d.prepare('SELECT author, video FROM notes WHERE id = ?').bind(id).first();
  if (!ex) return;
  if (ex.video !== video || (who.author !== 'owner' && ex.author !== who.author)) throw new HttpError(403, '只能刪除自己的意見');
  await d.batch([d.prepare('DELETE FROM notes WHERE id = ?').bind(id), d.prepare('DELETE FROM replies WHERE note = ?').bind(id)]);
}

// ---------- replies: a short thread under a note (owner and the note's guest) ----------
export async function addReply(d, video, noteId, text, who) {
  noteId = noteId && /^[\w-]{1,64}$/.test(noteId) ? noteId : null;
  const ex = noteId && await d.prepare('SELECT author, video FROM notes WHERE id = ?').bind(noteId).first();
  if (!ex || ex.video !== video) throw new HttpError(404, '找不到這則意見');
  if (who.author !== 'owner' && ex.author !== who.author) throw new HttpError(403, '只能回覆自己的意見');
  text = String(text || '').trim().slice(0, 2000);
  if (!text) throw new HttpError(400, '回覆是空的');
  const reply = { id: randomId(9), author: who.author, by: who.name || '', text, at: Date.now() };
  // touching the note marks it as changed, so the inbox and the "new" badges pick the reply up
  await d.batch([
    d.prepare('INSERT INTO replies (id, note, video, author, by, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(reply.id, noteId, video, reply.author, reply.by, reply.text, reply.at),
    d.prepare('UPDATE notes SET updated = ? WHERE id = ?').bind(reply.at, noteId),
  ]);
  return reply;
}
export async function deleteReply(d, video, id, who) {
  const ex = await d.prepare('SELECT author, video FROM replies WHERE id = ?').bind(String(id)).first();
  if (!ex) return;
  if (ex.video !== video || ex.author !== who.author) throw new HttpError(403, '只能刪除自己的回覆');
  await d.prepare('DELETE FROM replies WHERE id = ?').bind(String(id)).run();
}

// ---------- versions: 20261018_夏日新品_形象片_v2.mp4 and 20261019_夏日新品_形象片_v3.mp4 are one family ----------
export function versionOf(name) {
  const m = String(name || '').replace(/\.[^.]+$/, '').replace(/^\d{8}_/, '').match(/^(.+?)[_ -]?v(\d+)$/i);
  return m ? { family: m[1], v: +m[2] } : null;
}
// every video name ever seen, so a version moved to _封存 can still be found by its notes
export async function rememberNames(d, files) {
  const names = await getKv(d, 'names', {});
  let changed = false;
  for (const f of files) if (names[f.id] !== f.name) { names[f.id] = f.name; changed = true; }
  if (changed) await setKv(d, 'names', names);
  return names;
}
const isOpen = n => !n.done && n.decision !== 'reject';
export async function previousVersions(d, id, name, inFolder) {
  const me = versionOf(name), names = await getKv(d, 'names', {});
  if (!me) return [];
  const here = await listNotes(d, id), copied = new Set(here.map(n => n.carried?.id).filter(Boolean));
  const out = [];
  for (const [vid, vname] of Object.entries(names)) {
    const v = versionOf(vname);
    if (vid === id || !v || v.family !== me.family || v.v >= me.v) continue;
    const open = (await listNotes(d, vid)).filter(isOpen);
    out.push({ id: vid, name: vname, v: v.v, open: open.length, remaining: open.filter(n => !copied.has(n.id)).length,
      inFolder: inFolder.has(vid), carried: here.filter(n => n.carried?.video === vid).length });
  }
  return out.sort((a, b) => b.v - a.v);
}
// copy a previous version's open notes into this one; notes already copied are skipped
export async function carryNotes(d, id, fromId, fromName) {
  const here = await listNotes(d, id), done = new Set(here.map(n => n.carried?.id).filter(Boolean));
  const v = versionOf(fromName)?.v;
  let added = 0;
  for (const n of (await listNotes(d, fromId)).filter(isOpen)) {
    if (done.has(n.id)) continue;
    const { author, updated, replies, ...data } = n;
    const copy = { ...data, id: crypto.randomUUID(), done: false, origAuthor: n.origAuthor || author,
      carried: { video: fromId, id: n.id, v, name: fromName } };
    await putNote(d, id, copy.id, copy, { author: 'owner' });
    added++;
  }
  return added;
}

// ---------- per-video info: fps, start timecode, review status ----------
export const STATUSES = { review: '待審', changes: '需要修改', approved: '已核准' };
// fpsSource / startTcSource: 'manual' (set by hand, never overridden), 'auto' (read from the file) or 'default'.
// Older rows have no *Auto flag; a stored 29.97 / 00:00:00:00 there is just the old default, anything else was set by hand.
export async function getVideo(d, id) {
  const raw = await getKv(d, 'video:' + id, {});
  const source = (v, auto, dflt) => !v ? 'default' : auto ? 'auto' : auto === undefined && v === dflt ? 'default' : 'manual';
  return { fps: '29.97', startTc: '00:00:00:00', status: 'review', ...raw,
    fpsSource: source(raw.fps, raw.fpsAuto, '29.97'), startTcSource: source(raw.startTc, raw.startTcAuto, '00:00:00:00') };
}
export async function patchVideo(d, id, patch) {
  await setKv(d, 'video:' + id, { ...(await getKv(d, 'video:' + id, {})), ...patch });
  return getVideo(d, id);
}

// ---------- notifications to the owner: always in the app, by email when Resend is set up ----------
export async function notify(d, env, kind, text, share) {
  await d.prepare('INSERT INTO alerts (at, kind, share, text) VALUES (?, ?, ?, ?)').bind(Date.now(), kind, share || null, text).run();
  const to = (env.NOTIFY_EMAIL || env.OWNER_EMAILS || '').split(/[\s,;]+/).filter(Boolean)[0];
  if (!env.RESEND_API_KEY || !to) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.NOTIFY_FROM || '審片工具 <onboarding@resend.dev>', to: [to], subject: '【審片】' + text, text }),
  }).catch(err => console.error('notify email failed', err));
}

// ---------- guests' daily allowance for speech-to-text and AI polish ----------
export const dailyLimit = env => +env.GUEST_DAILY_LIMIT || 50;
export async function spend(d, env, share, waitUntil) {
  const limit = dailyLimit(env);
  const row = await d.prepare(`INSERT INTO usage (who, day, n) VALUES (?, ?, 1)
                               ON CONFLICT (who, day) DO UPDATE SET n = n + 1 RETURNING n`).bind('share:' + share.id, today()).first();
  if (row.n === limit + 1)
    waitUntil(notify(d, env, 'limit', `${share.label} 今天的語音／AI 次數已用完（${limit} 次）：${share.video_name || ''}`, share.id));
  if (row.n > limit)
    throw new HttpError(429, `今天的語音辨識／AI 潤飾次數已用完，可以先打字留言。已通知分享者。`, { limit: true });
}
export const usedToday = async (d, shareId) =>
  (await d.prepare('SELECT n FROM usage WHERE who = ? AND day = ?').bind('share:' + shareId, today()).first())?.n || 0;
export const addAllowance = (d, shareId, n) =>
  d.prepare('UPDATE usage SET n = MAX(0, n - ?) WHERE who = ? AND day = ?').bind(n, 'share:' + shareId, today()).run();
