// 系列共用的手繪畫筆(canvas)。紙、格線、摺線、抖動的線、墨跡、亂塗。
//
// 這裡只有「怎麼畫」,沒有任何一款遊戲的規則或物件:車窗跑者之後也用同一支筆。
// 紙上空戰專屬的東西(飛機的形狀、蓄力圈、筆桿)在 public/dogfight/app.js。
//
// 座標一律是遊戲自己的邏輯座標;縮放交給 fit() 設好的 transform。

// 決定性的雜湊,0 到 1。抖動要「每一格都一樣」才不會每 frame 亂跳。
export function hash1(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// 讀 CSS 的顏色 token(:root 上那一組)。
export function tokens(names) {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const n of names) out[n] = cs.getPropertyValue("--" + n).trim();
  return out;
}

export function reducedMotion() {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// 一條抖動的線。seed 決定抖的樣子;boil 每變一次線就重畫一次(手繪動畫)。
// amp 是抖動的幅度(邏輯座標)。boil 給 0 就是靜止的線。
export function sketch(ctx, x1, y1, x2, y2, seed, boil, amp) {
  const a = amp === undefined ? 1.2 : amp;
  const b = boil || 0;
  const j = (k) => (hash1((seed + k) * 7.3 + b * 13.7) - 0.5) * 2 * a;
  ctx.beginPath();
  ctx.moveTo(x1 + j(0), y1 + j(1));
  ctx.quadraticCurveTo((x1 + x2) / 2 + j(2) * 1.5, (y1 + y2) / 2 + j(3) * 1.5, x2 + j(4), y2 + j(5));
  ctx.stroke();
}

// 一張紙:底色、綠色格線、摺線那一條淡淡的陰影和虛線。
export function sheet(ctx, o) {
  const w = o.w;
  const h = o.h;
  ctx.fillStyle = o.sheet;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = o.rule;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = o.grid || 30;
  for (let y = step; y < h; y += step) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  if (o.fold === undefined) return;
  const g = ctx.createLinearGradient(0, o.fold - 16, 0, o.fold + 16);
  g.addColorStop(0, "rgba(58,63,70,0)");
  g.addColorStop(0.5, "rgba(58,63,70,.10)");
  g.addColorStop(1, "rgba(58,63,70,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, o.fold - 16, w, 32);
  ctx.strokeStyle = o.pencil;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 1.4;
  ctx.setLineDash([10, 9]);
  ctx.beginPath();
  ctx.moveTo(0, o.fold);
  ctx.lineTo(w, o.fold);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

// 一條墨跡:pts 的前 n 段,越到後面越細(筆滑出去時力道在放掉)。
export function ink(ctx, pts, n, color, total) {
  const m = total || pts.length - 1;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  for (let i = 1; i <= n && i < pts.length; i++) {
    ctx.lineWidth = 2.8 - 1.9 * (i / m);
    ctx.beginPath();
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  ctx.lineCap = "butt";
}

// 亂塗掉一個東西(作業簿上劃掉的那種)。
export function scribble(ctx, x, y, r, seed, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  for (let k = 0; k < 11; k++) {
    const p = (i) => (hash1(seed + k * 3 + i) - 0.5) * r * 2;
    sketch(ctx, x + p(0), y + p(1), x + p(2), y + p(3), seed + k, 0, 2);
  }
}

// 把 canvas 的實際像素配到 CSS 尺寸上,並設好邏輯座標的 transform。
// 回傳 CSS 像素 / 邏輯座標 的比例(輸入要把螢幕座標換算回邏輯座標時用)。
export function fit(cv, cssW, cssH, logicalW, logicalH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  cv.style.width = cssW + "px";
  cv.style.height = cssH + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(cv.width / logicalW, 0, 0, cv.height / logicalH, 0, 0);
  return cssW / logicalW;
}
