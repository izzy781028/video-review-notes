import { HttpError } from './http.js';

// D1 schema, created on first use so there is no migration step to run.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, video TEXT NOT NULL, author TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS notes_video ON notes (video)`,
  `CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, video TEXT NOT NULL, video_name TEXT,
     label TEXT NOT NULL, pin TEXT, pin_fails INTEGER NOT NULL DEFAULT 0, lock_device INTEGER NOT NULL DEFAULT 0, device TEXT,
     created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS shares_video ON shares (video)`,
  `CREATE TABLE IF NOT EXISTS opens (share TEXT NOT NULL, at INTEGER NOT NULL, ua TEXT, place TEXT)`,
  `CREATE TABLE IF NOT EXISTS usage (who TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (who, day))`,
  `CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, share TEXT, text TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
];

let ready = null;
export async function db(env) {
  if (!env.DB) throw new HttpError(500, '尚未綁定 D1 資料庫（Pages 設定 → 繫結，變數名稱 DB）');
  ready ||= env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))).catch(err => { ready = null; throw err; });
  await ready;
  return env.DB;
}

export async function getKv(d, k, fallback) {
  const row = await d.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return row ? JSON.parse(row.v) : fallback;
}
export const setKv = (d, k, v) =>
  d.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run();

export const DEFAULT_CONFIG = {
  reviewer: '',
  terms: '',
  cats: '剪接,字幕,字卡/圖像,調色,音效/音樂,旁白,畫面/特效,其他',
  polishModel: 'claude-opus-5-5',
  autoPolish: true,
  polishImage: true,
};
export const getConfig = async d => ({ ...DEFAULT_CONFIG, ...(await getKv(d, 'config', {})) });
