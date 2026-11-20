// 時:分:秒:格 for a note, from its frame (or seconds) and the video's fps and start timecode.
export const FPS = { '23.976': [24000 / 1001, 24], '24': [24, 24], '25': [25, 25], '29.97': [30000 / 1001, 30], '30': [30, 30],
  '50': [50, 50], '59.94': [60000 / 1001, 60], '60': [60, 60] };

export function timecode(n, fps = '29.97', start = '00:00:00:00') {
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
