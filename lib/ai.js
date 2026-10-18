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
- 只根據原話整理，不要加入原話沒有的要求、數值或創意。原話不清楚、需要跟審片人確認的地方，在句末標註【待確認：要確認的內容】。
- 如果附了截圖，只用來把原話裡「這裡、這個、那個字」對應到畫面上的具體元素（位置、顏色、文字內容），不要根據截圖自己提出新的修改。截圖上的紅圈是審片人點的位置。
- 只輸出整理後的修改指示本身，不要前言、標題或說明。`;

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export async function polish(env, config, input) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(500, '尚未設定 ANTHROPIC_API_KEY');
  const raw = String(input.raw || '').trim().slice(0, 4000);
  if (!raw) throw new HttpError(400, '沒有要潤飾的內容');
  const terms = config.terms.split('\n').map(s => s.trim()).filter(Boolean);
  const ctx = [`影片：${String(input.videoName || '').slice(0, 200)}`,
    `位置：${input.general ? '整體意見（不指定時間碼）' : '時間碼 ' + String(input.tc || '').slice(0, 20)}`,
    `類別：${String(input.cat || '').slice(0, 40)}`,
    terms.length ? `常用詞：${terms.join('、')}` : ''].filter(Boolean).join('\n');
  const content = [];
  const img = typeof input.image === 'string' && input.image.startsWith('data:image/jpeg;base64,') ? input.image.slice(23) : '';
  if (img && img.length < 1_500_000 && config.polishImage) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } });
  content.push({ type: 'text', text: `${ctx}\n\n<原話>\n${raw}\n</原話>` });

  const model = MODELS.includes(config.polishModel) ? config.polishModel : MODELS[0];
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const msg = await client.beta.messages.create({
    model, max_tokens: 4000,
    output_config: { effort: 'low' },
    // Haiku has no server-side fallback; Opus / Sonnet re-run a declined request on Anthropic's recommended model
    ...(model === 'claude-haiku-5-5' ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    system: POLISH_SYSTEM,
    messages: [{ role: 'user', content }],
  }).catch(err => { throw new HttpError(502, 'AI 潤飾失敗：' + (err.error?.error?.message || err.message)); });
  if (msg.stop_reason === 'refusal') throw new HttpError(422, 'AI 拒絕處理這段內容');
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (!text) throw new HttpError(502, 'AI 沒有回傳內容');
  return text;
}
