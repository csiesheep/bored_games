// 畫框:把畫框裡用像素記下來的筆畫,變成引擎收的 art。純函式,不 import DOM。
//
// 「畫大畫小都一樣好打」(規則筆記未知數 #4):畫只影響外觀,所以這裡一律把整張畫
// 縮放進 ±1 的框——置中、長的那一邊撐滿、長寬比不變。畫框有多大、手指畫在螢幕的哪裡,
// 送進引擎的東西都一樣。
//
// 上限(16 條筆畫 / 400 個點)不在這裡抄第二份:直接讀 engine.js 的 RULES。
// 超過上限就化簡到上限以內——引擎收到超過上限的畫會讓整個 setup 失敗,而玩家亂塗
// 一通是常態,不是錯誤。化簡只看「第幾條、第幾個點」,不看長度,所以放大十倍的
// 同一張畫會被化簡成同一個樣子。
//
// 送進引擎的 art 只能從這裡來(orchestrator 裁決 #9):app.js 不可以自己再縮放一次。

import { RULES } from "../shared/dogfight/engine.js";

const MARGIN = 0.07; // toBox 在框裡留的邊(佔框的比例)

const num = (v) => typeof v === "number" && Number.isFinite(v);

// 只留下看得懂的點;空的筆畫直接丟掉。
function clean(strokesPx) {
  const out = [];
  for (const s of Array.isArray(strokesPx) ? strokesPx : []) {
    if (!Array.isArray(s)) continue;
    const pts = [];
    for (const p of s) if (Array.isArray(p) && p.length >= 2 && num(p[0]) && num(p[1])) pts.push([p[0], p[1]]);
    if (pts.length) out.push(pts);
  }
  return out;
}

// 條數上限:留點數最多的那幾條(順序不變)。手滑點出來的一兩點先被丟掉。
function limitStrokes(strokes, max) {
  if (strokes.length <= max) return strokes;
  const keep = strokes
    .map((s, i) => [i, s.length])
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, max)
    .map(([i]) => i)
    .sort((a, b) => a - b);
  return keep.map((i) => strokes[i]);
}

// 等距抽 n 個點,頭尾一定留著。
function resample(s, n) {
  if (n >= s.length) return s;
  if (n <= 1) return [s[0]];
  const out = [];
  for (let i = 0; i < n; i++) out.push(s[Math.round((i * (s.length - 1)) / (n - 1))]);
  return out;
}

// 點數上限:每條先保底兩點,剩下的額度照原本的點數按比例分。
function limitPoints(strokes, max) {
  const total = strokes.reduce((a, s) => a + s.length, 0);
  if (total <= max) return strokes;
  const floors = strokes.map((s) => Math.min(s.length, 2));
  const base = floors.reduce((a, b) => a + b, 0);
  const spare = Math.max(0, max - base);
  const extra = strokes.reduce((a, s, i) => a + (s.length - floors[i]), 0);
  return strokes.map((s, i) => {
    const give = extra > 0 ? Math.floor(((s.length - floors[i]) * spare) / extra) : 0;
    return resample(s, Math.max(1, floors[i] + give));
  });
}

// 四捨五入到小數三位,並夾回 ±1:引擎連 1.0000000000000002 都會拒絕。
function q(v) {
  const r = Math.round(v * 1000) / 1000;
  return r > 1 ? 1 : r < -1 ? -1 : r === 0 ? 0 : r;
}

// strokesPx = [[[px, py], …], …](任何座標、任何大小)→ 引擎收的 art,或 null(什麼都沒畫)。
export function toArt(strokesPx) {
  let strokes = clean(strokesPx);
  if (!strokes.length) return null;
  strokes = limitPoints(limitStrokes(strokes, RULES.ART_STROKES), RULES.ART_POINTS);

  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const s of strokes)
    for (const p of s) {
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  const span = Math.max(x1 - x0, y1 - y0);
  const k = span > 0 ? 2 / span : 0; // 只點一下:整張畫縮成原點,不除以零
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return strokes.map((s) => s.map((p) => [q((p[0] - cx) * k), q((p[1] - cy) * k)]));
}

// 反過來:art(±1)→ 框裡的分數座標(0 到 1),四周留 MARGIN 的邊。
// 「畫飛機那一頁打開時框裡先顯示上次的畫」用的。art 是 null 就回空的。
export function toBox(art, margin) {
  const m = margin === undefined ? MARGIN : margin;
  const k = 0.5 * (1 - 2 * m);
  if (!Array.isArray(art)) return [];
  return art.map((s) => s.map((p) => [0.5 + p[0] * k, 0.5 + p[1] * k]));
}
