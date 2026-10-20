import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './http.js';

// Speech to text: ElevenLabs Scribe v2, biased toward the team's vocabulary.
export async function transcribe(env, file, terms) {
  if (!env.ELEVENLABS_API_KEY) throw new HttpError(500, '尚未設定 ELEVENLABS_API_KEY');
  if (!file || typeof file === 'string') throw new HttpError(400, '沒有收到錄音');
  if (file.size > 25_000_000) throw new HttpError(413, '錄音太長');
  const fd = new FormData();
  fd.append('file', file, file.name || 'note.webm');
  fd.append('model_id', 'scribe_v2');
  fd.append('language_code', 'zho');
  fd.append('tag_audio_events', 'false');
  terms.slice(0, 100).forEach(t => fd.append('keyterms', t));
  const base = (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  const r = await fetch(base + '/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': env.ELEVENLABS_API_KEY }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, '語音辨識失敗：' + (j.detail?.message || JSON.stringify(j.detail || j)));
  return (j.text || '').trim();
}

const POLISH_SYSTEM = `你是台灣影片後製團隊的修改意見整理助手。使用者會給你審片人針對影片某個時間點（或整支影片）講的修改意見，通常是語音辨識結果，口語、有贅字、口頭禪、可能有辨識錯字，而且中英夾雜。

請把它改寫成剪接師可以直接照著執行的修改指示：
- 使用繁體中文（台灣用語）。英文術語、品牌名、專有名詞保留原文，例如 Logo、B-roll、Super、CTA、Fade in。
- 去掉口頭禪、重複與語助詞，修正明顯的語音辨識錯字（可參考提供的常用詞）。
- 寫清楚「改哪裡、改成什麼、怎麼改」。只有一件事就寫一兩句；有多件事就分點，每點以「1. 」「2. 」開頭。
- 只根據原話整理，不要加入原話沒有的要求、數值或創意。原話沒講清楚的地方（例如沒說要改成多少），就照原話的程度寫，不要自己補上，也不要加註、提問或標記待確認。
- 如果附了截圖，只用來把原話裡「這裡、這個、那個字」對應到畫面上的具體元素（位置、顏色、文字內容），不要根據截圖自己提出新的修改。截圖上的紅圈、紅色箭頭、方框或手繪線條是審片人標出的位置。
- 只輸出整理後的修改指示本身，不要前言、標題或說明。`;

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const pickModel = config => MODELS.includes(config.polishModel) ? config.polishModel : MODELS[0];
// ANTHROPIC_BASE_URL may point at the ai-proxy Worker (pinned to the US); AI_PROXY_TOKEN authenticates to it
const client = env => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY,
  ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL.replace(/\/+$/, '') } : {}),
  ...(env.AI_PROXY_TOKEN ? { defaultHeaders: { 'x-clipnote-proxy': env.AI_PROXY_TOKEN } } : {}) });
// "Request not allowed" = Anthropic refused the region this server ran in (e.g. Hong Kong)
const aiError = (what, err) => {
  const m = err.error?.error?.message || err.message || '';
  if (err.status === 403 && err.error?.error === 'forbidden') return new HttpError(502, `${what}：AI 中繼拒絕連線，請確認 Pages 的 AI_PROXY_TOKEN 和中繼 Worker 的 PROXY_TOKEN 一樣。`);
  return new HttpError(502, /request not allowed|not supported/i.test(m) && err.status === 403
    ? `${what}：Anthropic 不接受這台伺服器所在地區的連線（Cloudflare 可能從香港節點連出）。請照 docs/SETUP.md「AI 中繼」設定。`
    : `${what}：${m}`);
};
// Haiku has no server-side fallback; Opus / Sonnet re-run a declined request on Anthropic's recommended model
const fallback = model => model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

export async function polish(env, config, input) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, '尚未設定 ANTHROPIC_API_KEY');
  const raw = String(input.raw || '').trim().slice(0, 4000);
  if (!raw) throw new HttpError(400, '沒有要潤飾的內容');
  const terms = config.terms.split('\n').map(s => s.trim()).filter(Boolean);
  const ctx = [`影片：${String(input.videoName || '').slice(0, 200)}`,
    `位置：${input.general ? '整體意見（不指定時間碼）' : '時間碼 ' + String(input.tc || '').slice(0, 20)}`,
    input.cat ? `類別：${String(input.cat).slice(0, 40)}` : '',
    terms.length ? `常用詞：${terms.join('、')}` : ''].filter(Boolean).join('\n');
  const content = [];
  const img = typeof input.image === 'string' && input.image.startsWith('data:image/jpeg;base64,') ? input.image.slice(23) : '';
  if (img && img.length < 1_500_000 && config.polishImage) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
  content.push({ type: 'text', text: `${ctx}\n\n<原話>\n${raw}\n</原話>` });

  const model = pickModel(config);
  const msg = await client(env).beta.messages.create({
    model, max_tokens: 4000,
    output_config: { effort: 'low' },
    ...fallback(model),
    system: POLISH_SYSTEM,
    messages: [{ role: 'user', content }],
  }).catch(err => { throw aiError('AI 潤飾失敗', err); });
  if (msg.stop_reason === 'refusal') throw new HttpError(422, 'AI 拒絕處理這段內容');
  // no 【待確認…】 notes in the result, even if the model adds one anyway
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').replace(/[ \t]*【待確認[^】]*】/g, '').trim();
  if (!text) throw new HttpError(502, 'AI 沒有回傳內容');
  return text;
}

// ---------- AI summary: all open notes on one video -> a to-do list, duplicates, conflicts, open questions ----------
// The same prompt and schema are used by the browser in the single-device mode (public/index.html).
const SUMMARY_SYSTEM = `你是台灣影片後製團隊的審片助理。使用者會給你一支影片目前所有未完成的修改意見，每則有編號、時間碼、來源（「你」是剪接師本人，其他名字是客戶）、類別和內容。

請整理成剪接師可以直接開工的清單：
- todo：合併成具體的待辦事項，依影片時間順序排列。意思相同的意見合併成一項，refs 列出所有相關編號。detail 寫清楚改哪裡、改成什麼。priority：會影響播出或客戶明確要求的是 high，一般修改是 normal，可有可無的是 low。
- duplicates：內容重複或幾乎相同的意見（至少兩則）。
- conflicts：互相矛盾的要求，例如一則說加快、一則說放慢；特別注意客戶和「你」之間的矛盾。note 說明衝突在哪裡。
- questions：內容不清楚、需要先確認才能動手的地方（例如只說「調一下」沒說調多少）。
- summary：一兩句話說明整體狀況。
只根據提供的意見整理，不要加入新的修改建議。使用繁體中文（台灣用語），英文術語保留原文。沒有的項目給空陣列。`;
const refs = { type: 'array', items: { type: 'integer' } };
const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'todo', 'duplicates', 'conflicts', 'questions'],
  properties: {
    summary: { type: 'string' },
    todo: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['title', 'detail', 'refs', 'priority'],
      properties: { title: { type: 'string' }, detail: { type: 'string' }, refs, priority: { type: 'string', enum: ['high', 'normal', 'low'] } } } },
    duplicates: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['refs', 'note'], properties: { refs, note: { type: 'string' } } } },
    conflicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['refs', 'note'], properties: { refs, note: { type: 'string' } } } },
    questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['refs', 'question'], properties: { refs, question: { type: 'string' } } } },
  },
};
export async function summarize(env, config, input) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, '尚未設定 ANTHROPIC_API_KEY');
  const items = (Array.isArray(input.items) ? input.items : []).slice(0, 300);
  if (!items.length) throw new HttpError(400, '沒有未完成的意見可以彙整');
  const line = i => `#${+i.no || 0}｜${String(i.tc || '').slice(0, 40)}｜來源：${String(i.source || '').slice(0, 40)}｜${String(i.cat || '').slice(0, 40)}\n${String(i.text || '').slice(0, 3000)}`
    + (i.decision ? `\n（剪接師的決定：${String(i.decision).slice(0, 300)}）` : '');
  const text = `影片：${String(input.videoName || '').slice(0, 200)}\n\n${items.map(line).join('\n\n')}`;
  const model = pickModel(config);
  const msg = await client(env).beta.messages.create({
    model, max_tokens: 16000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
    ...fallback(model),
    system: SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: text }],
  }).catch(err => { throw aiError('AI 彙整失敗', err); });
  if (msg.stop_reason === 'refusal') throw new HttpError(422, 'AI 拒絕處理這段內容');
  try { return JSON.parse(msg.content.filter(b => b.type === 'text').map(b => b.text).join('')); }
  catch { throw new HttpError(502, 'AI 回傳的格式不正確，請再試一次'); }
}
