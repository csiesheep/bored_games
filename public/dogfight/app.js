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
import { pressure, slipAt, wobble, hintLen, isCancel } from "./feel.js";

const $ = (id) => document.getElementById(id);
const W = E.RULES.W;
const H = E.RULES.H;
const N = E.RULES.SAMPLES;
const LEVELS = ["easy", "normal", "hard"];
const SHOT_S = 0.3; // 一條線畫完要幾秒
const BOT_AIM_S = 1.1; // 電腦「瞄準」的演出長度
const PICK_R = 46; // 點多近才算點到自己的飛機(邏輯座標)

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
  st = E.setup(seed);
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
  if (!aim || phase !== "turn") return;
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
  P.sketch(ctx, -18, 0, 22, 0, s, b);
  P.sketch(ctx, -2, -21, 8, 0, s + 1, b);
  P.sketch(ctx, 8, 0, -2, 21, s + 2, b);
  P.sketch(ctx, -2, -21, -6, 0, s + 3, b);
  P.sketch(ctx, -6, 0, -2, 21, s + 4, b);
  P.sketch(ctx, -18, -9, -13, 0, s + 5, b);
  P.sketch(ctx, -13, 0, -18, 9, s + 6, b);
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

// ───────────────────────────── 起動 ─────────────────────────────
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
  $("stage").hidden = false;

  C = P.tokens(["sheet", "rule", "pencil", "red", "blue", "black"]);
  C.side = [C.blue, C.black];
  reduced = P.reducedMotion();

  newSheet();
  layout();
  addEventListener("resize", layout);
  if (window.visualViewport) visualViewport.addEventListener("resize", layout);
  bindInput();
  $("again").addEventListener("click", () => {
    newSheet();
    layout();
  });

  // 給驗證用的窗口(不是給玩家的):這一局的種子、送進引擎的每一手、現在的 state。
  // E.replay(seed, actions) 必須跟 state 一模一樣。
  window.__dogfight = {
    record: () => ({ seed, actions: actions.map((a) => ({ ...a })), state: E.clone(st), mode, level }),
  };

  requestAnimationFrame(frame);
}

main();
