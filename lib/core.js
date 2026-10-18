import { HttpError, today } from './http.js';
import { getKv, setKv } from './db.js';

// ---------- notes (one row per note, so owner and guests never overwrite each other) ----------
const noteId = id => { if (!/^[\w-]{1,64}$/.test(id || '')) throw new HttpError(400, '意見編號錯誤'); return id; };

export async function listNotes(d, video, author) {
  const q = author
    ? d.prepare('SELECT data, author, updated FROM notes WHERE video = ? AND author = ?').bind(video, author)
    : d.prepare('SELECT data, author, updated FROM notes WHERE video = ?').bind(video);
  const { results } = await q.all();
  return results.map(r => ({ ...JSON.parse(r.data), author: r.author, updated: r.updated }));
}

export async function putNote(d, video, id, note, who) {
  noteId(id);
  const ex = await d.prepare('SELECT author, video FROM notes WHERE id = ?').bind(id).first();
  if (ex && (ex.video !== video || (who.author !== 'owner' && ex.author !== who.author)))
    throw new HttpError(403, '只能修改自己的意見');
  const data = { ...note, id };
  delete data.video; delete data.author; delete data.updated;
  if (who.author !== 'owner') {
    data.by = who.name;
    delete data.decision; delete data.decisionNote;
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
  await d.prepare('DELETE FROM notes WHERE id = ?').bind(id).run();
}

// ---------- per-video info: fps, start timecode, review status ----------
export const STATUSES = { review: '待審', changes: '需要修改', approved: '已核准' };
export const getVideo = async (d, id) => ({ fps: '29.97', startTc: '00:00:00:00', status: 'review', ...(await getKv(d, 'video:' + id, {})) });
export async function patchVideo(d, id, patch) {
  const v = { ...(await getVideo(d, id)), ...patch };
  await setKv(d, 'video:' + id, v);
  return v;
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
