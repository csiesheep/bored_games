// 紙上空戰的 driver:輪次、輸入、動畫、畫面。
//
// 三條不可協商的線(orchestrator 裁決 #6):
//   1. 規則只有 engine.js 一份。每一手都是 E.apply(st, {type:'fire', plane, ang, pr});
//      擊毀、出界、換人、結束、出手上限,一律讀 apply 回傳的 state。這裡的動畫只是把
//      state.inks 最後那一條慢慢畫出來,不自己算命中——不然畫面和引擎會各說各話。
//   2. 電腦的手只從 bots.choose(E.view(st, 1), 1, level, seed) 來。「瞄準」那一秒是演出,
//      手是先決定好的。
//   3. 手感的數字只在 feel.js。
//
// 玩家看得到的字一個都不在這裡,只有 key(i18n.js 負責查)。

import * as E from "../shared/dogfight/engine.js";
import * as B from "../shared/dogfight/bots.js";
import * as P from "../shared/paper.js";
import * as I from "../shared/i18n.js";
import * as D from "./draw.js";
import { pressure, slipAt, wobble, hintLen, isCancel } from "./feel.js";

const $ = (id) => document.getElementById(id);
const W = E.RULES.W;
const H = E.RULES.H;
const N = E.RULES.SAMPLES;
const LEVELS = ["easy", "normal", "hard"];
const SHOT_S = 0.3; // 一條線畫完要幾秒
const BOT_AIM_S = 1.1; // 電腦「瞄準」的演出長度
const PICK_R = 46; // 點多近才算點到自己的飛機(邏輯座標)
// 自己畫的飛機只影響外觀(orchestrator 裁決 #9):命中半徑、PICK_R 都不看 art。
const ART_R = 22; // 紙上那個固定大小的框(跟預設飛機差不多大)
const ART_KEY = "bg.dogfight.art"; // 上一次畫的:[座位 0 的三張, 座位 1 的三張]

let C = {}; // 顏色 token
let reduced = false;

// ───────────────────────────── 規則頁 ─────────────────────────────
// 六句話從 rules.1 到 rules.6,圖是靜態的 SVG(在頁面裡)。
function renderRules() {
  const ol = $("rulesList");
  if (!ol) return;
  for (let i = 1; i <= 6; i++) {
    const li = document.createElement("li");
    li.textContent = I.t("rules." + i);
    ol.appendChild(li);
  }
  const back = $("rulesBack");
  if (back) back.textContent = I.t("nav.back");
  const title = $("rulesTitle");
  if (title) title.textContent = I.t("rules.title");
  document.title = I.t("rules.title") + " · " + I.t("game.title");
}

// ───────────────────────────── 一局 ─────────────────────────────
let mode = "bot"; // 'bot' | 'pair'
let level = "normal";
let seed = 0;
let st = null; // 引擎的 state,唯一的真相
let actions = []; // 送進引擎的每一手,照順序
let phase = "turn"; // 'turn' | 'shot' | 'pause' | 'over'
let aim = null; // 玩家按住的那一手
let botPlan = null; // 電腦先決定好的那一手
let shot = null; // 正在畫的那一條線
let pauseT = 0;
let msgKey = null;
let time = 0;
let boil = 0;

const cv = $("cv");
const ctx = cv ? cv.getContext("2d") : null;
const turnEl = $("turn");
const sheetEl = $("sheet");
const overEl = $("over");

const aliveCount = (s) => st.planes.filter((p) => p.side === s && p.alive).length;
const planeById = (state, id) => state.planes.find((p) => p.id === id);

function newSheet() {
  seed = (Math.random() * 4294967296) | 0;
  st = E.setup(seed, { art: engineArt() });
  actions = [];
  aim = botPlan = shot = null;
  msgKey = null;
  phase = "turn";
  if (overEl) overEl.hidden = true;
  banner();
  maybeBot();
}

// 輪次提示:輪到誰、在哪一側。對坐時座位 1 的提示在上方、轉 180°。
function banner() {
  if (!turnEl) return;
  turnEl.className = "df-turn";
  if (phase === "over") {
    turnEl.textContent = " ";
    return;
  }
  if (msgKey) {
    turnEl.textContent = I.t(msgKey);
    turnEl.classList.add("alert");
  } else if (mode === "bot") {
    turnEl.textContent =
      st.turn === 0 ? I.t("turn.you") : I.t("turn.bot", { name: I.t("setup.bot." + level + ".name") });
    turnEl.classList.add("s" + st.turn);
  } else {
    turnEl.textContent = st.turn === 0 ? I.t("turn.blue") : I.t("turn.black");
    turnEl.classList.add("s" + st.turn);
  }
  if (mode === "pair" && st.turn === 1) turnEl.classList.add("top");
  layout();
}

// ───────────────────────────── 出手 ─────────────────────────────
// 唯一一個呼叫 E.apply 的地方。動畫要的東西全部從新舊 state 的差算出來。
function fire(planeId, ang, pr) {
  const action = { type: "fire", plane: planeId, ang, pr };
  let next;
  try {
    next = E.apply(st, action);
  } catch (_) {
    aim = null;
    botPlan = null;
    return;
  }
  const line = next.inks[next.inks.length - 1];
  // 引擎說這一手毀掉了誰(不是我自己算的)。動畫只決定「什麼時候讓它出現」。
  const reveal = [];
  for (const p of next.planes) {
    const before = planeById(st, p.id);
    if (!before.alive || p.alive || p.id === planeId) continue;
    let at = 0;
    let bd = Infinity;
    line.pts.forEach((q, i) => {
      const d = Math.hypot(q.x - before.x, q.y - before.y);
      if (d < bd) {
        bd = d;
        at = i;
      }
    });
    reveal.push({ id: p.id, at });
  }
  shot = { action, next, pts: line.pts, side: line.side, planeId, t: 0, n: 0, reveal, kills: reveal.length };
  aim = null;
  botPlan = null;
  msgKey = null;
  phase = "shot";
  banner();
}

function stepShot(dt) {
  shot.t = Math.min(1, shot.t + dt / SHOT_S);
  const e = 1 - Math.pow(1 - shot.t, 3);
  shot.n = Math.round(e * N);
  if (shot.t < 1) return;

  // 這一手結束:採用引擎回傳的 state,訊息也從它算。
  actions.push(shot.action);
  const me = planeById(shot.next, shot.planeId);
  const kills = shot.kills;
  const out = !!me.lost;
  st = shot.next;
  shot = null;
  msgKey =
    kills && out ? "msg.killButOut" : kills > 1 ? "msg.multikill" : kills === 1 ? "msg.kill" : out ? "msg.out" : null;
  // 兩邊都還有飛機卻 over,只可能是出手上限(引擎的第 3 條結束條件)。
  if (st.over && aliveCount(0) > 0 && aliveCount(1) > 0) msgKey = "msg.cap";
  phase = "pause";
  pauseT = msgKey ? 0.9 : 0.25;
  banner();
}

function nextTurn() {
  msgKey = null;
  if (st.over) {
    showOver();
    return;
  }
  phase = "turn";
  banner();
  maybeBot();
}

// 電腦的手:先決定好,再演一秒。
function maybeBot() {
  if (mode !== "bot" || st.over || st.turn !== 1) return;
  const botSeed = (st.seed ^ Math.imul(actions.length + 1, 0x9e3779b1)) | 0;
  const a = B.choose(E.view(st, 1), 1, level, botSeed);
  botPlan = { id: a.plane, ang: a.ang, pr: a.pr, t: 0 };
}

// ───────────────────────────── 結束 ─────────────────────────────
function showOver() {
  phase = "over";
  banner();
  const w = st.winner;
  const left = w === null ? aliveCount(0) : aliveCount(w);
  let titleKey = "over.draw";
  let vars = null;
  if (w !== null) {
    if (mode === "bot") {
      titleKey = w === 0 ? "over.youWin" : "over.botWins";
      if (w === 1) vars = { name: I.t("setup.bot." + level + ".name") };
    } else {
      titleKey = w === 0 ? "over.blueWins" : "over.blackWins";
    }
  }
  $("overTitle").textContent = I.t(titleKey, vars);
  $("overSummary").textContent = I.t("over.summary", { lines: st.inks.length, left });
  // 評語(orchestrator 裁決 #6):贏家剩 3 / 2 / 1 架 = 甲上 / 甲 / 乙上。
  // 單人模式玩家輸了、或平手,不給評語。
  const graded = w !== null && !(mode === "bot" && w === 1);
  const g = $("overGrade");
  g.hidden = !graded;
  if (graded) g.textContent = I.t(["grade.bplus", "grade.a", "grade.aplus"][Math.min(2, Math.max(0, left - 1))]);
  overEl.hidden = false;
}

// ───────────────────────────── 輸入 ─────────────────────────────
function toLogical(e) {
  const r = cv.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height };
}

function myTurn() {
  return phase === "turn" && !st.over && !(mode === "bot" && st.turn === 1);
}

function onDown(e) {
  if (!myTurn() || aim) return;
  e.preventDefault();
  const q = toLogical(e);
  let best = null;
  let bd = PICK_R;
  for (const p of st.planes) {
    if (!p.alive || p.side !== st.turn) continue;
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  if (!best) return;
  aim = { id: best.id, px: q.x, py: q.y, t0: performance.now(), t: 0, pointer: e.pointerId };
  try {
    cv.setPointerCapture(e.pointerId);
  } catch (_) {}
}

function onMove(e) {
  if (!aim || e.pointerId !== aim.pointer) return;
  const q = toLogical(e);
  aim.px = q.x;
  aim.py = q.y;
}

// 拉回飛機 CANCEL_R 以內 → 取消,不出手也不換人。
function aimAngle() {
  const p = planeById(st, aim.id);
  const dx = p.x - aim.px;
  const dy = p.y - aim.py;
  return isCancel(dx, dy) ? null : Math.atan2(dy, dx);
}

function release() {
  if (!aim) return;
  // 放開的時候已經不是可以出手的時候(例如手指還按著就換了畫面):放掉這一手,
  // 但一定要把 aim 清掉,不然按住的狀態會卡住,之後再也點不動自己的飛機。
  if (phase !== "turn") {
    aim = null;
    return;
  }
  const a = aimAngle();
  if (a === null) {
    aim = null;
    return;
  }
  const pr = pressure(aim.t);
  fire(aim.id, a + wobble(aim.t, pr), pr);
}

function bindInput() {
  cv.addEventListener("pointerdown", onDown);
  cv.addEventListener("pointermove", onMove);
  cv.addEventListener("pointerup", (e) => {
    if (aim && e.pointerId === aim.pointer) release();
  });
  cv.addEventListener("pointercancel", () => {
    aim = null;
  });
  addEventListener("contextmenu", (e) => e.preventDefault());
}

// ───────────────────────────── 更新 ─────────────────────────────
function update(dt) {
  if (phase === "turn") {
    if (aim) {
      aim.t = (performance.now() - aim.t0) / 1000; // 真的時間,不是累加的 frame
      if (aim.t > slipAt()) release(); // 撐太久,筆自己滑出去
    }
    if (botPlan) {
      botPlan.t += dt;
      if (botPlan.t > BOT_AIM_S) fire(botPlan.id, botPlan.ang, botPlan.pr);
    }
  } else if (phase === "shot") {
    stepShot(dt);
  } else if (phase === "pause") {
    pauseT -= dt;
    if (pauseT <= 0) nextTurn();
  }
}

// ───────────────────────────── 畫 ─────────────────────────────
function drawPlane(p, opts) {
  if (p.lost) return; // 飛出紙外的不畫在紙上
  const o = opts || {};
  const dead = o.dead !== undefined ? o.dead : !p.alive;
  const x = o.x !== undefined ? o.x : p.x;
  const y = o.y !== undefined ? o.y : p.y;
  const ang = o.ang !== undefined ? o.ang : p.ang;
  const live = !dead && phase === "turn" && p.side === st.turn && !reduced;
  const s = p.id * 10 + 3;
  const b = live ? boil : 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.strokeStyle = C.side[p.side];
  ctx.lineWidth = 2.6;
  ctx.lineCap = "round";
  ctx.globalAlpha = dead ? 0.3 : 1;
  if (p.art) {
    // 自己畫的:縮放進固定大小的框,機頭(art 的 −y)對準飛機的朝向(這裡的 +x)。
    ctx.lineJoin = "round";
    for (let i = 0; i < p.art.length; i++) {
      P.scrawl(ctx, p.art[i].map((q) => [-q[1] * ART_R, q[0] * ART_R]), s + i, b);
    }
    ctx.lineJoin = "miter";
  } else {
    P.sketch(ctx, -18, 0, 22, 0, s, b);
    P.sketch(ctx, -2, -21, 8, 0, s + 1, b);
    P.sketch(ctx, 8, 0, -2, 21, s + 2, b);
    P.sketch(ctx, -2, -21, -6, 0, s + 3, b);
    P.sketch(ctx, -6, 0, -2, 21, s + 4, b);
    P.sketch(ctx, -18, -9, -13, 0, s + 5, b);
    P.sketch(ctx, -13, 0, -18, 9, s + 6, b);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  if (dead) {
    const by = o.by !== undefined ? o.by : p.by;
    P.scribble(ctx, x, y, 27, s, C.side[by === null || by === undefined ? 1 - p.side : by]);
  }
  ctx.lineCap = "butt";
}

// 蓄力圈、只露前三成的提示虛線、往後倒的筆。
function drawPen(x, y, ang, pr, t, side) {
  const a = ang + wobble(t, pr);
  const col = C.side[side];
  const over = pr >= 1;
  ctx.strokeStyle = over ? C.red : col;
  ctx.globalAlpha = over ? 0.5 + 0.5 * Math.sin(time * 22) : 0.55;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, 36, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pr);
  ctx.stroke();

  ctx.strokeStyle = col;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 8]);
  ctx.lineCap = "round";
  const g = hintLen(pr);
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(a) * 30, y + Math.sin(a) * 30);
  ctx.lineTo(x + Math.cos(a) * (30 + g), y + Math.sin(a) * (30 + g));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const L = 160 - 60 * pr;
  const bx = -Math.cos(a);
  const by = -Math.sin(a);
  const seg = (f0, f1, wid, c) => {
    ctx.strokeStyle = c;
    ctx.lineWidth = wid;
    ctx.beginPath();
    ctx.moveTo(x + bx * L * f0, y + by * L * f0);
    ctx.lineTo(x + bx * L * f1, y + by * L * f1);
    ctx.stroke();
  };
  seg(0, 0.1, 3, C.pencil);
  seg(0.1, 1, 11, C.pencil);
  seg(0.11, 0.99, 8, C.sheet);
  seg(0.11, 0.3, 8, col);
  seg(0.86, 0.99, 8, col);
  ctx.lineCap = "butt";
}

function draw() {
  if (!ctx || !st) return;
  P.sheet(ctx, { w: W, h: H, fold: E.RULES.FOLD, sheet: C.sheet, rule: C.rule, pencil: C.pencil });
  for (const k of st.inks) P.ink(ctx, k.pts, N, C.side[k.side], N);

  if (shot) {
    P.ink(ctx, shot.pts, shot.n, C.side[shot.side], N);
    const moving = planeById(st, shot.planeId);
    const dying = new Set(shot.reveal.filter((r) => shot.n >= r.at).map((r) => r.id));
    for (const p of st.planes) {
      if (p.id === shot.planeId) continue;
      drawPlane(p, dying.has(p.id) ? { dead: true, by: moving.side } : null);
    }
    const i = Math.max(1, shot.n);
    const b = shot.pts[i];
    const a = shot.pts[i - 1];
    drawPlane(moving, { x: b.x, y: b.y, ang: Math.atan2(b.y - a.y, b.x - a.x), dead: false });
  } else {
    for (const p of st.planes) drawPlane(p);
  }

  if (phase === "turn" && aim) {
    const p = planeById(st, aim.id);
    const a = aimAngle();
    if (a !== null) drawPen(p.x, p.y, a, pressure(aim.t), aim.t, p.side);
    else {
      ctx.strokeStyle = C.pencil;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 36, 0, 7);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  if (phase === "turn" && botPlan) {
    const p = planeById(st, botPlan.id);
    drawPen(p.x, p.y, botPlan.ang, botPlan.pr * Math.min(1, botPlan.t / BOT_AIM_S), botPlan.t, 1);
  }
}

// ───────────────────────────── 版面 ─────────────────────────────
// 紙是 2:3,整張紙 + 上面那一條 + 輪次提示要一起塞進可見高度,不捲動。
function layout() {
  if (!sheetEl) return;
  const stage = sheetEl.parentElement;
  const availW = stage.clientWidth;
  const availH = stage.clientHeight - turnEl.offsetHeight - 6;
  const sc = Math.min(availW / W, availH / H, 1);
  const cw = Math.max(40, Math.floor(W * sc));
  const ch = Math.max(60, Math.floor(H * sc));
  sheetEl.style.width = cw + "px";
  sheetEl.style.height = ch + "px";
  sheetEl.style.fontSize = Math.max(11, Math.min(18, 17 * sc * 1.3)) + "px";
  P.fit(cv, cw, ch, W, H);
}

let last = 0;
function frame(ts) {
  const dt = Math.min(0.033, (ts - last) / 1000 || 0);
  last = ts;
  time += dt;
  boil = Math.floor(time * 7);
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

// ───────────────────────────── 畫飛機 ─────────────────────────────
// 選完對手(?play=…)或對坐(?pair)之後、開打之前的那一頁。
// 送進引擎的 art 只從 D.toArt 來:這裡不自己縮放第二次。
// 框裡的筆畫記的是「佔框的幾分之幾」(0 到 1),所以轉螢幕、換手機都不會走樣;
// toArt 本來就把整張畫縮放進 ±1,單位是什麼都一樣。
const noArt = () => [null, null, null];
let ART = [noArt(), noArt()]; // 記在 localStorage 的那兩份
let pads = []; // 三個框
let drawSeat = 0;
let flipped = false;
let activeBox = -1;

// 電腦用預設的飛機(#9 明確不做「電腦對手的飛機造型」)。
const engineArt = () => [ART[0], mode === "pair" ? ART[1] : noArt()];

// localStorage 壞掉 / 存的東西引擎不收(舊格式、被人改過)→ 當成沒畫過,不要整頁掛掉。
function loadArt() {
  let raw = null;
  try {
    raw = localStorage.getItem(ART_KEY);
  } catch (_) {
    return [noArt(), noArt()];
  }
  if (!raw) return [noArt(), noArt()];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v) || v.length !== 2) return [noArt(), noArt()];
    E.setup(0, { art: v }); // 唯一的判準:引擎收不收
    return v.map((side) => (Array.isArray(side) ? side.slice(0, E.RULES.PLANES) : noArt()));
  } catch (_) {
    return [noArt(), noArt()];
  }
}

function saveArt() {
  try {
    localStorage.setItem(ART_KEY, JSON.stringify(ART));
  } catch (_) {}
}

function padSize(p) {
  return Math.max(1, Math.round(p.box.clientWidth));
}

function renderPad(p) {
  const w = padSize(p);
  const h = Math.max(1, Math.round(p.box.clientHeight));
  P.fit(p.cv, w, h, w, h);
  const c = p.cv.getContext("2d");
  c.clearRect(0, 0, w, h);
  c.strokeStyle = C.side[drawSeat];
  c.lineWidth = 2.6;
  c.lineCap = "round";
  c.lineJoin = "round";
  for (const s of p.strokes) {
    c.beginPath();
    for (let i = 0; i < s.length; i++) {
      const x = s[i][0] * w;
      const y = s[i][1] * h;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    if (s.length === 1) c.lineTo(s[0][0] * w + 0.01, s[0][1] * h);
    c.stroke();
  }
  p.hint.hidden = p.strokes.length > 0;
}

// 螢幕座標 → 框裡的分數座標。出框回 null(那一筆就結束)。轉 180° 時兩軸都翻。
function padPos(p, e) {
  const r = p.cv.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  let x = (e.clientX - r.left) / r.width;
  let y = (e.clientY - r.top) / r.height;
  if (flipped) {
    x = 1 - x;
    y = 1 - y;
  }
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return [x, y];
}

function bindPad(p, i) {
  p.cv.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (p.cur) return;
    const q = padPos(p, e);
    if (!q) return;
    activeBox = i;
    p.cur = [q];
    p.pointer = e.pointerId;
    p.strokes.push(p.cur);
    try {
      p.cv.setPointerCapture(e.pointerId);
    } catch (_) {}
    renderPad(p);
  });
  p.cv.addEventListener("pointermove", (e) => {
    if (!p.cur || e.pointerId !== p.pointer) return;
    const q = padPos(p, e);
    if (!q) {
      p.cur = null; // 拖出框外:這一筆結束,不連到下一筆
      return;
    }
    const last = p.cur[p.cur.length - 1];
    if (Math.abs(q[0] - last[0]) + Math.abs(q[1] - last[1]) < 0.004) return;
    p.cur.push(q);
    renderPad(p);
  });
  const end = (e) => {
    if (e.pointerId === p.pointer) {
      p.cur = null;
      p.pointer = null;
    }
  };
  p.cv.addEventListener("pointerup", end);
  p.cv.addEventListener("pointercancel", end);
}

function fillPads(seat) {
  pads.forEach((p, i) => {
    p.strokes = D.toBox(ART[seat] && ART[seat][i]);
    p.cur = null;
    p.pointer = null;
    renderPad(p);
  });
  activeBox = -1;
}

function startDraw(seat) {
  drawSeat = seat;
  flipped = mode === "pair" && seat === 1;
  const sec = $("draw");
  sec.classList.toggle("flip", flipped);
  const who = $("drawWho");
  who.hidden = mode !== "pair";
  if (mode === "pair") who.textContent = I.t(seat === 0 ? "draw.blue" : "draw.black");
  sec.hidden = false;
  fillPads(seat);
}

function finishDraw(useDefaults) {
  ART[drawSeat] = useDefaults ? noArt() : pads.map((p) => D.toArt(p.strokes));
  if (mode === "pair" && drawSeat === 0) {
    startDraw(1);
    return;
  }
  saveArt();
  $("draw").hidden = true;
  beginPlay();
}

function setupDraw() {
  const boxes = document.querySelectorAll(".df-box");
  pads = Array.from(boxes).map((box) => ({
    box,
    cv: box.querySelector(".df-pad"),
    hint: box.querySelector(".df-hint"),
    strokes: [],
    cur: null,
    pointer: null,
  }));
  pads.forEach(bindPad);
  $("drawRedo").addEventListener("click", () => {
    const p = pads[activeBox];
    if (!p) return;
    p.strokes = [];
    p.cur = null;
    renderPad(p);
  });
  $("drawDefaults").addEventListener("click", () => finishDraw(true));
  $("drawDone").addEventListener("click", () => finishDraw(false));
  addEventListener("resize", () => {
    if (!$("draw").hidden) pads.forEach(renderPad);
  });
}

// ───────────────────────────── 起動 ─────────────────────────────
function beginPlay() {
  $("stage").hidden = false;
  newSheet();
  layout();
  addEventListener("resize", layout);
  if (window.visualViewport) visualViewport.addEventListener("resize", layout);
  bindInput();
  $("again").addEventListener("click", () => {
    // 再撕一張:沿用同一份畫,不用重畫。
    newSheet();
    layout();
  });

  // 給驗證用的窗口(不是給玩家的):這一局的種子、送進引擎的每一手、現在的 state、
  // 還有傳給 setup 的那份畫。E.replay(seed, actions, {art}) 必須跟 state 一模一樣。
  window.__dogfight = {
    record: () => ({ seed, actions: actions.map((a) => ({ ...a })), state: E.clone(st), art: E.clone(engineArt()), mode, level }),
  };

  requestAnimationFrame(frame);
}

async function main() {
  await I.init();
  I.apply(document);
  const page = document.body.dataset.page;
  if (page === "rules") {
    renderRules();
    return;
  }
  const q = new URLSearchParams(location.search);
  const play = q.get("play");
  const pair = q.has("pair");
  if (!(play && LEVELS.includes(play)) && !pair) {
    $("setup").hidden = false;
    return;
  }
  mode = pair ? "pair" : "bot";
  level = pair ? null : play;
  document.body.classList.add("df-playing");

  C = P.tokens(["sheet", "rule", "pencil", "red", "blue", "black"]);
  C.side = [C.blue, C.black];
  reduced = P.reducedMotion();

  ART = loadArt();
  setupDraw();
  startDraw(0);
}

main();
