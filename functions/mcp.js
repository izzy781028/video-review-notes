// 片語 as an MCP server for Claude Code: `claude mcp add --transport http clipnote https://<site>/mcp`
// with the Cloudflare Access service-token headers. Stateless Streamable HTTP: every POST is one JSON-RPC
// message answered with JSON. Each tool calls the owner API in-process with the caller's Access JWT,
// so the API's own checks (service token = owner) apply unchanged.
import { onRequest as ownerApi } from './api/[[path]].js';
import { db, getKv, setKv } from '../lib/db.js';
import { ownerEmail } from '../lib/auth.js';
import { HttpError } from '../lib/http.js';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const STATUS = { review: '待審', changes: '需要修改', approved: '已核准' };
const DECISION = { accept: '照改', adjust: '改法調整', reject: '不改' };
const SHAPES = { arrow: '箭頭', box: '方框', pen: '手繪線' };
const FPS = { '23.976': [24000 / 1001, 24], '24': [24, 24], '25': [25, 25], '29.97': [30000 / 1001, 30], '30': [30, 30],
  '50': [50, 50], '59.94': [60000 / 1001, 60], '60': [60, 60] };

const INSTRUCTIONS = `片語（Clipnote）是阿湯的線上審片工具：阿湯和客戶在影片上留時間碼意見，這些工具讓你讀意見、看截圖和參考圖、記錄處理結果。
- 意見分兩種：「你」（阿湯自己）的意見直接照做；「客戶」的意見要逐則問使用者：照改、改法調整（問怎麼改）或不改，再用 record_decision 記下。不要自己替客戶意見做決定。
- 有畫面標記（箭頭、方框、手繪、畫面位置）或「附了參考圖」的意見，先用 get_note_images 看圖再判斷指的是哪裡。參考圖是想要的樣子（風格、字型、配色、構圖），照意見文字判斷要參考哪一部分，不要整張照抄。
- 改好一則就用 set_done 標記。reply_to_note 的回覆客戶看得到，送出前先給使用者看內容並得到同意。
- 時間碼格式 時:分:秒:格。「從 X 帶入」的意見是上一版延續下來的，時間碼可能已隨剪接變動。
- 看新動態用 get_inbox；使用者確認看過後用 ack_inbox，下次 get_inbox 就只列之後的新意見。`;

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const VIDEO = str('影片 id，或檔名的一部分（例如「夏日新品」「B Copy」）');
const NOTE = str('意見 id（get_notes / get_inbox 列出的 id=…）');
const TOOLS = [
  { name: 'list_videos', description: '列出審片資料夾裡的影片（最新的在前）：審核狀態、意見數、新的客戶意見數。',
    inputSchema: { type: 'object', properties: { query: str('只列檔名包含這段文字的影片（選填）') } } },
  { name: 'get_inbox', description: '有新動態的影片和未完成的意見。預設只列上次 ack_inbox 之後新增或修改的意見；all=true 列出所有未完成意見。',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: '列出所有未完成的意見' } } } },
  { name: 'ack_inbox', description: '記下：這次 get_inbox 看到的意見都確認過了。下次 get_inbox 只列這之後的新意見。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_notes', description: '一支影片的所有意見（含時間碼、誰留的、回覆、處理狀態、是否附參考圖）。',
    inputSchema: { type: 'object', properties: { video: VIDEO, open_only: { type: 'boolean', description: '只列還沒完成的' } }, required: ['video'] } },
  { name: 'get_note_images', description: '看一則意見的畫面截圖（含審片人畫的標記）和附的參考圖。',
    inputSchema: { type: 'object', properties: { video: VIDEO, note: NOTE }, required: ['video', 'note'] } },
  { name: 'set_done', description: '把一則意見標成「已修改」（done=false 改回未完成）。',
    inputSchema: { type: 'object', properties: { video: VIDEO, note: NOTE, done: { type: 'boolean', description: '預設 true' } }, required: ['video', 'note'] } },
  { name: 'record_decision', description: '記下使用者對一則客戶意見的決定。只有阿湯看得到，客戶看不到。',
    inputSchema: { type: 'object', properties: { video: VIDEO, note: NOTE,
      decision: str('accept = 照改、adjust = 改法調整、reject = 不改', { enum: ['accept', 'adjust', 'reject'] }),
      comment: str('改法或不改的原因（選填）') }, required: ['video', 'note', 'decision'] } },
  { name: 'reply_to_note', description: '在一則意見下面回覆。客戶看得到這則回覆，送出前先讓使用者確認內容。',
    inputSchema: { type: 'object', properties: { video: VIDEO, note: NOTE, text: str('回覆內容') }, required: ['video', 'note', 'text'] } },
  { name: 'set_review_status', description: '改一支影片的審核狀態：review 待審、changes 需要修改、approved 已核准。',
    inputSchema: { type: 'object', properties: { video: VIDEO, status: str('review / changes / approved', { enum: ['review', 'changes', 'approved'] }) }, required: ['video', 'status'] } },
];

// ---------- helpers ----------
function timecode(n, fps = '29.97', start = '00:00:00:00') {
  if (n.general) return '整體意見';
  const [rate, tb] = FPS[fps] || FPS['29.97'];
  const m = String(start).match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  const offset = m ? ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * tb + +m[4] : 0;
  const tc = (frame, t) => {
    const f = (frame ?? Math.floor((t || 0) * rate + 1e-4)) + offset, p = x => String(x).padStart(2, '0');
    return `${p(Math.floor(f / (tb * 3600)))}:${p(Math.floor(f / (tb * 60)) % 60)}:${p(Math.floor(f / tb) % 60)}:${p(f % tb)}`;
  };
  return tc(n.frame, n.t) + (n.frame2 != null || n.t2 != null ? ' → ' + tc(n.frame2, n.t2) : '');
}
const isClient = n => String(n.origAuthor || n.author || 'owner').startsWith('share:');
function noteText(n, fps, start, showNew) {
  const who = isClient(n) ? `客戶：${n.by || '外部審片'}${!n.submitted && !n.carried ? '（還沒按送出，可能還在看）' : ''}` : '你';
  const marks = [n.pt ? `畫面位置 x${Math.round(n.pt.x * 100)}% y${Math.round(n.pt.y * 100)}%` : '',
    n.shapes?.length ? '畫面上有' + [...new Set(n.shapes.map(s => SHAPES[s.type] || '標記'))].join('、') : ''].filter(Boolean).join('，');
  const lines = [`- ${showNew && n.new ? '🆕 ' : ''}[${timecode(n, fps, start)}] ${who}${marks ? `（${marks}）` : ''}  id=${n.id}`,
    ...String(n.text || '').split('\n').map(l => '    ' + l)];
  if (n.raw && n.raw !== n.text) lines.push(`    （原始口述：${n.raw.replace(/\n/g, ' ')}）`);
  if (n.refs?.length) lines.push(`    （附了 ${n.refs.length} 張參考圖，用 get_note_images 看）`);
  if (n.carried) lines.push(`    （從 ${n.carried.label || 'v' + (n.carried.v ?? '?')} 帶入，時間碼可能已隨剪接變動）`);
  if (n.decision) lines.push(`    → 你的決定：${DECISION[n.decision] || n.decision}${n.decisionNote ? '：' + n.decisionNote : ''}`);
  for (const r of n.replies || []) lines.push(`    ↳ ${r.by || '你'}：${String(r.text).replace(/\n/g, ' ')}`);
  if (n.done) lines.push('    ✓ 已修改');
  return lines.join('\n');
}
const byTime = (a, b) => (a.general ? -1 : a.t) - (b.general ? -1 : b.t);
const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

// ---------- the tools ----------
async function callTool(name, args, call, d) {
  const video = async key => {
    const { files } = await call('/videos');
    const k = String(key || '').trim().toLowerCase();
    const hits = files.filter(f => f.id === key);
    const found = hits.length ? hits : files.filter(f => f.name.toLowerCase().includes(k));
    if (!k || !found.length) throw new HttpError(404, `找不到影片「${key}」，先用 list_videos 看清單`);
    if (found.length > 1) throw new HttpError(400, '有多支影片符合，請寫得更完整或用 id：\n' + found.slice(0, 20).map(f => `- ${f.name}  id=${f.id}`).join('\n'));
    return found[0];
  };
  const noteOf = async (v, id) => {
    const res = await call(`/videos/${encodeURIComponent(v.id)}`);
    const n = res.notes.find(n => n.id === id);
    if (!n) throw new HttpError(404, `「${v.name}」裡沒有這則意見（id=${id}）`);
    return { n, res };
  };
  switch (name) {
    case 'list_videos': {
      const { files } = await call('/videos'), q = String(args.query || '').toLowerCase();
      const list = files.filter(f => !q || f.name.toLowerCase().includes(q));
      if (!list.length) return q ? `沒有檔名包含「${args.query}」的影片。` : '審片資料夾裡沒有影片。';
      return `共 ${list.length} 支${list.length > 60 ? '（只列最新 60 支，可用 query 篩選）' : ''}：\n` + list.slice(0, 60).map(f =>
        `- ${f.name}  [${STATUS[f.status] || '待審'}]  ${f.notes || 0} 則意見${f.fresh ? `，${f.fresh} 則新的客戶意見` : ''}  id=${f.id}`).join('\n');
    }
    case 'get_inbox': {
      const since = await getKv(d, 'mcp_since', 0);
      const res = await call('/inbox?since=' + since);
      await setKv(d, 'mcp_pending', res.now);
      const vids = args.all ? res.videos : res.videos.filter(v => v.new || (v.statusAt || 0) > since);
      const when = since ? new Date(since).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '第一次檢查';
      if (!vids.length) return `沒有新的審片意見（上次確認：${when}）。`;
      const out = [args.all ? `所有未完成的意見（🆕 = ${when} 之後新增或修改）：` : `上次確認：${when}。有新動態的影片 ${vids.length} 支：`];
      for (const v of vids) {
        out.push(`\n■ ${v.name}  [${STATUS[v.status] || '待審'}${v.statusBy ? `（${v.statusBy}）` : ''}]  未完成 ${v.open} 則，新 ${v.new} 則  id=${v.id}`);
        const shown = v.notes.filter(n => args.all || n.new), mine = shown.filter(n => !isClient(n)), theirs = shown.filter(isClient);
        if (mine.length) out.push('  你的意見（直接照做）：', ...mine.map(n => noteText(n, v.fps, v.startTc, args.all)));
        if (theirs.length) out.push('  客戶意見（請使用者逐則決定：照改／改法調整／不改）：', ...theirs.map(n => noteText(n, v.fps, v.startTc, args.all)));
      }
      out.push('\n→ 使用者確認看過後呼叫 ack_inbox。');
      return out.join('\n');
    }
    case 'ack_inbox': {
      const p = await getKv(d, 'mcp_pending', 0);
      if (!p) throw new HttpError(400, '還沒呼叫過 get_inbox');
      await setKv(d, 'mcp_since', p);
      return '已記下：這次之前的意見都確認過了。';
    }
    case 'get_notes': {
      const v = await video(args.video), res = await call(`/videos/${encodeURIComponent(v.id)}`);
      const notes = res.notes.filter(n => !args.open_only || (!n.done && n.decision !== 'reject')).sort(byTime);
      return `■ ${v.name}  [${STATUS[res.info.status] || '待審'}]  共 ${res.notes.length} 則，未完成 ${res.notes.filter(n => !n.done && n.decision !== 'reject').length} 則  id=${v.id}\n`
        + (notes.length ? notes.map(n => noteText(n, res.info.fps, res.info.startTc)).join('\n') : '（沒有意見）');
    }
    case 'get_note_images': {
      const v = await video(args.video), { n, res } = await noteOf(v, args.note);
      const content = [{ type: 'text', text: noteText(n, res.info.fps, res.info.startTc) }];
      const shot = String(n.thumb || '').match(/^data:(image\/\w+);base64,(.+)$/);
      if (shot) content.push({ type: 'text', text: '畫面截圖（含審片人畫的標記）：' }, { type: 'image', mimeType: shot[1], data: shot[2] });
      let total = 0;
      for (const [i, r] of (n.refs || []).entries()) {
        const resp = await call(`/images/${encodeURIComponent(r.id)}`, {}, true);
        const buf = await resp.arrayBuffer();
        if ((total += buf.byteLength) > 4_000_000) { content.push({ type: 'text', text: `（參考圖 ${i + 1} 之後太大，先看到這裡）` }); break; }
        content.push({ type: 'text', text: `參考圖 ${i + 1}：` }, { type: 'image', mimeType: resp.headers.get('content-type') || 'image/jpeg', data: b64(buf) });
      }
      if (content.length === 1) content.push({ type: 'text', text: '這則意見沒有截圖或參考圖。' });
      return content;
    }
    case 'set_done': {
      const v = await video(args.video), { n } = await noteOf(v, args.note), done = args.done !== false;
      await call(`/videos/${encodeURIComponent(v.id)}/notes/${encodeURIComponent(n.id)}`, { method: 'PATCH', json: { done } });
      return `已把「${String(n.text).slice(0, 30)}」標成${done ? '已修改' : '未完成'}。`;
    }
    case 'record_decision': {
      const v = await video(args.video), { n } = await noteOf(v, args.note);
      await call(`/videos/${encodeURIComponent(v.id)}/notes/${encodeURIComponent(n.id)}`, { method: 'PATCH', json: { decision: args.decision, decisionNote: args.comment || '' } });
      return `已記下決定：${DECISION[args.decision]}${args.comment ? '：' + args.comment : ''}`;
    }
    case 'reply_to_note': {
      const v = await video(args.video), { n } = await noteOf(v, args.note);
      if (!String(args.text || '').trim()) throw new HttpError(400, '回覆內容是空的');
      await call(`/videos/${encodeURIComponent(v.id)}/notes/${encodeURIComponent(n.id)}/replies`, { method: 'POST', json: { text: args.text } });
      return '已回覆（對方看得到）。';
    }
    case 'set_review_status': {
      const v = await video(args.video);
      await call(`/videos/${encodeURIComponent(v.id)}`, { method: 'PATCH', json: { status: args.status } });
      return `「${v.name}」改成${STATUS[args.status]}。`;
    }
  }
  throw new HttpError(400, '沒有這個工具：' + name);
}

const rpc = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } });
const rpcError = (id, code, message, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });

export async function onRequest(ctx) {
  const { request, env, waitUntil } = ctx;
  if (request.method !== 'POST') return new Response('POST JSON-RPC messages here (MCP Streamable HTTP).', { status: 405, headers: { allow: 'POST' } });
  try { await ownerEmail(request, env); } catch (err) { return rpcError(null, -32001, err.message, err.status || 401); }
  let msg;
  try { msg = await request.json(); } catch { return rpcError(null, -32700, 'Parse error', 400); }
  if (Array.isArray(msg)) return rpcError(null, -32600, '一次送一則訊息', 400);
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return new Response(null, { status: 202 }); // notifications need no answer

  if (method === 'initialize') return rpc(id, {
    protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0],
    capabilities: { tools: {} }, serverInfo: { name: 'clipnote', title: '片語 Clipnote', version: '1.0.0' }, instructions: INSTRUCTIONS });
  if (method === 'ping') return rpc(id, {});
  if (method === 'tools/list') return rpc(id, { tools: TOOLS });
  if (method !== 'tools/call') return rpcError(id, -32601, 'Method not found: ' + method);

  // run the owner API in-process, with the caller's Access credentials
  const origin = new URL(request.url).origin, jwt = request.headers.get('cf-access-jwt-assertion') || '';
  const call = async (path, opts = {}, raw = false) => {
    const url = new URL('/api' + path, origin);
    const headers = { 'cf-access-jwt-assertion': jwt, ...(opts.json ? { 'content-type': 'application/json' } : {}) };
    const res = await ownerApi({ request: new Request(url, { method: opts.method || 'GET', headers, body: opts.json ? JSON.stringify(opts.json) : undefined }),
      env, waitUntil, params: { path: url.pathname.slice(5).split('/').filter(Boolean) } });
    if (raw && res.ok) return res;
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, j.error || `HTTP ${res.status}`);
    return j;
  };
  try {
    const out = await callTool(params.name, params.arguments || {}, call, await db(env));
    return rpc(id, { content: typeof out === 'string' ? [{ type: 'text', text: out }] : out });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    return rpc(id, { content: [{ type: 'text', text: '失敗：' + (err.message || err) }], isError: true });
  }
}
