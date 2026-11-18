import { HttpError, today } from './http.js';
import { getKv, setKv } from './db.js';
import { listNotes, versionOf, earlierNotes, getVideo, notify } from './core.js';
import { listVideos, canTrash, folderId } from './google.js';
import { checkAi } from './ai.js';

// ---------- 系統狀態: one check per moving part, so a broken setting shows up by name ----------
const ok = (name, detail) => ({ name, state: 'ok', detail });
const bad = (name, detail) => ({ name, state: 'fail', detail });
const warn = (name, detail) => ({ name, state: 'warn', detail });
const off = (name, detail) => ({ name, state: 'off', detail });
const msg = err => String(err?.message || err).slice(0, 300);
const timed = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('逾時沒有回應')), ms))]);

export async function health(env, d, config) {
  const checks = await Promise.all([
    timed(listVideos(env)).then(f => ok('Google Drive 影片資料夾', `讀得到，${f.length} 支影片`), e => bad('Google Drive 影片資料夾', msg(e))),
    (async () => {
      if (!env.ELEVENLABS_API_KEY) return bad('語音辨識（ElevenLabs）', '尚未設定 ELEVENLABS_API_KEY');
      const base = (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
      const r = await timed(fetch(base + '/v1/user', { headers: { 'xi-api-key': env.ELEVENLABS_API_KEY } }));
      const j = await r.json().catch(() => ({}));
      if (r.ok) return ok('語音辨識（ElevenLabs）', 'Key 有效');
      // a key limited to speech-to-text may not read the account, but it is still a valid key
      if (j.detail?.status === 'missing_permissions') return ok('語音辨識（ElevenLabs）', 'Key 有效（只開了需要的權限）');
      if (r.status === 401) return bad('語音辨識（ElevenLabs）', 'Key 無效：' + (j.detail?.message || '請重新貼上 ELEVENLABS_API_KEY'));
      return warn('語音辨識（ElevenLabs）', `無法確認（HTTP ${r.status}），錄一段語音試試看`);
    })().catch(e => warn('語音辨識（ElevenLabs）', '無法確認：' + msg(e))),
    timed(checkAi(env, config)).then(model => ok('AI 潤飾（Anthropic）', `連線正常，模型 ${model}`), e => bad('AI 潤飾（Anthropic）', msg(e))),
    (async () => {
      if (!env.ANTHROPIC_BASE_URL) return off('AI 中繼', '沒有使用（AI 潤飾正常就不需要）');
      const r = await timed(fetch(env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') + '/check', { headers: { 'x-clipnote-proxy': env.AI_PROXY_TOKEN || '' } }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return bad('AI 中繼', j.why || j.error || `HTTP ${r.status}`);
      return ok('AI 中繼', `從 ${j.colo} 機房連出`);
    })().catch(e => bad('AI 中繼', msg(e))),
    (async () => {
      if (!canTrash(env)) return off('刪除小幫手', '沒有設定（影片列表不會出現刪除鈕）');
      const r = await timed(fetch(env.DRIVE_HELPER_URL.trim(), { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: env.DRIVE_HELPER_TOKEN, action: 'check' }) }));
      const j = JSON.parse(await r.text());
      return j.ok ? ok('刪除小幫手', `可以刪「${j.folder}」裡的影片`) : bad('刪除小幫手', j.error);
    })().catch(e => bad('刪除小幫手', '沒有回應：' + msg(e) + '（確認 DRIVE_HELPER_URL 是 /exec 結尾，部署時存取權選「所有人」）')),
    (async () => {
      if (!env.ACCESS_SERVICE_TOKEN_ID) return off('本機 Claude', '沒有設定服務權杖');
      const seen = await getKv(d, 'svc_seen', 0);
      return seen ? ok('本機 Claude', '最近一次連線：' + new Date(seen).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }))
        : warn('本機 Claude', '已設定服務權杖，但還沒連線過（在本機跑 clipnote check 試試）');
    })(),
    Promise.resolve(env.RESEND_API_KEY ? ok('Email 通知', '已設定，寄到 ' + (env.NOTIFY_EMAIL || env.OWNER_EMAILS || '').split(/[\s,;]+/)[0])
      : off('Email 通知', '沒有設定（通知只顯示在片語裡）')),
  ]);
  return { checks, storage: await storage(d) };
}

export async function storage(d) {
  const n = await d.prepare('SELECT COUNT(*) AS c, COUNT(DISTINCT video) AS v, COALESCE(SUM(LENGTH(data)), 0) AS b FROM notes').first();
  const i = await d.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(data)), 0) AS b FROM images').first();
  return { notes: n.c, videos: n.v, images: i.c, bytes: n.b + i.b, limit: 5e9 };
}

// local Claude: remember when it last connected (written at most every 10 minutes)
export async function sawService(d) {
  const seen = await getKv(d, 'svc_seen', 0);
  if (Date.now() - seen > 600e3) await setKv(d, 'svc_seen', Date.now());
}

// ---------- 給客戶的通知訊息: where a client's notes stand on the version their link shows now ----------
export async function shareProgress(d, row) {
  const cur = await getKv(d, 'sharecur:' + row.id, null);
  const s = { ...row, origVideo: row.video, origName: row.video_name, video: cur?.id || row.video, video_name: cur?.name || row.video_name };
  const author = 'share:' + row.id, v = versionOf(s.video_name);
  const prev = (await earlierNotes(d, s, author))[0]; // the newest earlier version they commented on
  const here = await listNotes(d, s.video, author), info = await getVideo(d, s.video);
  return {
    current: { name: s.video_name, label: v?.label || '', title: (v?.family || s.video_name.replace(/\.[^.]+$/, '').replace(/^\d{8}_/, '')).replace(/_/g, ' ') },
    prev: prev ? { label: prev.label, total: prev.notes.length, fixed: prev.notes.filter(n => n.fixed).length } : null,
    here: { total: here.length },
    status: info.status, statusBy: info.statusBy || '',
  };
}

// ---------- 審片期限 ----------
export const dueOf = (d, id) => getKv(d, 'sharedue:' + id, null);
export async function setDue(d, id, due) {
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new HttpError(400, '期限格式錯誤');
  if (due) await setKv(d, 'sharedue:' + id, due); else await d.prepare('DELETE FROM kv WHERE k = ?').bind('sharedue:' + id).run();
  await d.prepare('DELETE FROM kv WHERE k = ?').bind('duealert:' + id).run();
}
// the day before (and the day after) a deadline, tell the owner about clients who have not sent anything yet
export async function dueAlerts(d, env) {
  const { results } = await d.prepare("SELECT k, v FROM kv WHERE k LIKE 'sharedue:%'").all();
  const day = today(), tomorrow = new Date(Date.parse(day) + 86400e3).toISOString().slice(0, 10);
  for (const { k, v } of results) {
    const id = k.slice(9), due = JSON.parse(v);
    const stage = day > due ? 'overdue' : (due === day || due === tomorrow) ? 'soon' : null;
    if (!stage || (await getKv(d, 'duealert:' + id, null)) === stage + due) continue;
    const row = await d.prepare('SELECT * FROM shares WHERE id = ? AND revoked = 0').bind(id).first();
    if (!row || row.expires < Date.now()) continue;
    const p = await shareProgress(d, row);
    await setKv(d, 'duealert:' + id, stage + due);
    if (p.here.total || p.status === 'approved') continue; // they answered
    const when = due.slice(5).replace('-', '/');
    await notify(d, env, 'due', stage === 'soon'
      ? `${row.label || '外部審片連結'} 的「${p.current.title}」審片期限是 ${when}${due === day ? '（今天）' : '（明天）'}，還沒留意見`
      : `${row.label || '外部審片連結'} 的「${p.current.title}」已經過了審片期限 ${when}，還沒留意見`, id);
  }
}

// ---------- 備份 / 清理 ----------
export async function exportAll(d) {
  const names = await getKv(d, 'names', {});
  const { results: vids } = await d.prepare('SELECT DISTINCT video FROM notes UNION SELECT DISTINCT video FROM images').all();
  const videos = [];
  for (const { video } of vids) videos.push({ id: video, name: names[video] || '', info: await getVideo(d, video), notes: await listNotes(d, video) });
  const { results: images } = await d.prepare('SELECT id, video, author, w, h, at, LENGTH(data) AS bytes FROM images').all();
  const { results: shares } = await d.prepare('SELECT id, video, video_name, label, created, expires, revoked FROM shares').all();
  return { app: 'clipnote', exported: new Date().toISOString(), videos, images, shares };
}

// data kept for videos that are no longer in the review folder (deleted, or moved to _封存)
export async function orphans(env, d) {
  const inFolder = new Set((await listVideos(env)).map(f => f.id)), names = await getKv(d, 'names', {});
  const { results } = await d.prepare(`SELECT video, SUM(n) AS notes, SUM(i) AS images, SUM(b) AS bytes FROM (
      SELECT video, 1 AS n, 0 AS i, LENGTH(data) AS b FROM notes UNION ALL SELECT video, 0, 1, LENGTH(data) FROM images) GROUP BY video`).all();
  return results.filter(r => !inFolder.has(r.video)).map(r => ({ id: r.video, name: names[r.video] || '（名稱不明）', notes: r.notes, images: r.images, bytes: r.bytes }));
}
export async function cleanup(env, d, ids) {
  if (!folderId(env)) throw new HttpError(500, '尚未設定 DRIVE_FOLDER');
  const allowed = new Set((await orphans(env, d)).map(o => o.id));
  const go = (Array.isArray(ids) ? ids : []).filter(id => allowed.has(id));
  for (const id of go) await d.batch([
    d.prepare('DELETE FROM notes WHERE video = ?').bind(id), d.prepare('DELETE FROM replies WHERE video = ?').bind(id),
    d.prepare('DELETE FROM images WHERE video = ?').bind(id), d.prepare('DELETE FROM kv WHERE k = ?').bind('video:' + id),
  ]);
  return go.length;
}
