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
// 第四條,只在連線模式(orchestrator 裁決 #14):
//   4. **伺服器是唯一的真相。** `mode === "room"` 的時候這裡一次 `E.setup` / `E.apply` 都不跑:
//      畫面只照伺服器送來的 `view` 畫,出手是送 `{t:"fire"}` 然後等它的 `state`。客戶端根本
//      沒有 `rng`(view 裡沒有),自己算一次的話兩支手機的誤差亂數不一樣,畫面馬上分岔。
//      倒數只用 `net.js` 的 `remainingMs`(伺服器的 `now`),不拿 `deadline` 減本機的時鐘。
//
// 玩家看得到的字一個都不在這裡,只有 key(i18n.js 負責查)。

import * as E from "../shared/dogfight/engine.js";
import * as B from "../shared/dogfight/bots.js";
import * as P from "../shared/paper.js";
import * as I from "../shared/i18n.js";
import * as D from "./draw.js";
import * as NET from "./net.js";
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
const CLOCK_MS = 10000; // 自己這一手剩這麼多以內才顯示倒數
const FLASH_S = 2.6; // 「對方回來了」這種一句話留在畫面上幾秒
const ROOM_BOT = "normal"; // 連線模式頂替的一律 normal(#14 明確不做「選電腦等級」)

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
let mode = "bot"; // 'bot' | 'pair' | 'room'
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

// ── 連線模式的狀態(mode === "room" 才有意義)────────────────────────────
// 這裡一個規則都沒有:srv 是伺服器最後一則 state,原樣收著;st 是「畫到哪裡了」的那一份
// view(動畫還沒播完的時候會落後 srv 一手)。
let conn = null; // 這一局唯一的那條 WebSocket
let code = ""; // 房間碼
let token = ""; // 這個分頁在這個房間的身分
let seat = 0; // 伺服器指派的座位(0 藍、1 黑)
let srv = null; // 最後一則 {t:"state", …}
let srvAt = 0; // 收到它的時候,本機的 Date.now()
let pendingView = undefined; // 還沒吃進畫面的 view(動畫播完才吃)
let sent = false; // 這一手送出去了,在伺服器回話之前不再收輸入
let netKey = null; // 自己的連線出事:net.lost
let fatalKey = null; // 走不下去了:room.full
let flashKey = null; // 一句短訊息:net.oppBot / net.oppBack
let flashT = 0;
let offBase = null; // 對方離線那一刻的 state(只拿它的 now 當倒數的起點)
let offAt = 0;
let waitFrom = 0; // 等人頁是什麼時候開始的(本機時間)
let sheetFlip = false; // 座位 1:整張紙轉 180°,自己永遠在下方

const cv = $("cv");
const ctx = cv ? cv.getContext("2d") : null;
const turnEl = $("turn");
const sheetEl = $("sheet");
const overEl = $("over");
const roomEl = $("room");

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
  if (mode === "room") return roomBanner(); // 連線模式的提示另外算(見「連線」一節)
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
  if (mode === "room") {
    // 連線模式:規則在伺服器。這裡只把這一手送出去,然後**什麼都不做**——墨跡、換人、
    // 命中都要等伺服器的 state 回來才會出現。伺服器不收這一手(bad_move / not_your_turn),
    // 畫面上就應該一條線都沒有。
    const okSent = conn ? conn.send({ t: "fire", plane: planeId, ang, pr }) : false;
    aim = null;
    botPlan = null;
    if (okSent) sent = true; // 等回話,這中間不再收輸入
    banner();
    return;
  }
  const action = { type: "fire", plane: planeId, ang, pr };
  let next;
  try {
    next = E.apply(st, action);
  } catch (_) {
    aim = null;
    botPlan = null;
    return;
  }
  animate(st, next, planeId, action, null);
}

// 「上一份 state / view」→「新的一份」:這一條線怎麼畫、誰什麼時候被塗掉。
// 兩種模式共用:本機模式的 next 是 E.apply 的結果,連線模式的 next 是伺服器送來的 view。
// 這裡不判斷命中——誰毀了是比對前後兩份得到的,動畫只決定「什麼時候讓它出現」。
function animate(prev, next, planeId, action, autoKey) {
  const line = next.inks[next.inks.length - 1];
  // 引擎說這一手毀掉了誰(不是我自己算的)。動畫只決定「什麼時候讓它出現」。
  const reveal = [];
  for (const p of next.planes) {
    const before = planeById(prev, p.id);
    if (!before || !before.alive || p.alive || p.id === planeId) continue;
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
  shot = { action, next, pts: line.pts, side: line.side, planeId, t: 0, n: 0, reveal, kills: reveal.length, autoKey };
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
  if (shot.action) actions.push(shot.action); // 連線模式沒有本機的手序(record() 也不回傳)
  const autoKey = shot.autoKey;
  const me = planeById(shot.next, shot.planeId);
  const kills = shot.kills;
  const out = !!me.lost;
  st = shot.next;
  shot = null;
  msgKey =
    kills && out ? "msg.killButOut" : kills > 1 ? "msg.multikill" : kills === 1 ? "msg.kill" : out ? "msg.out" : null;
  // 兩邊都還有飛機卻 over,只可能是出手上限(引擎的第 3 條結束條件)。
  if (st.over && aliveCount(0) > 0 && aliveCount(1) > 0) msgKey = "msg.cap";
  // 逾時代打蓋過擊毀的訊息:「時間到,電腦替你出了一手」是這一手裡唯一意外的事。
  if (autoKey) msgKey = autoKey;
  phase = "pause";
  pauseT = msgKey ? 0.9 : 0.25;
  banner();
}

function nextTurn() {
  msgKey = null;
  if (mode === "room") {
    phase = "turn";
    applyPending(); // 動畫播完了,把等著的那一份 view 吃進來(可能又是一手,或是結束)
    return;
  }
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
    if (mode === "room") {
      // 自己永遠是「你」;對面那個座位被電腦接手了就用班長的名字。
      const opp = srv ? srv.seats[1 - seat] : null;
      titleKey = w === seat ? "over.youWin" : opp && opp.kind === "bot" ? "over.botWins" : "over.oppWins";
      if (titleKey === "over.botWins") vars = { name: I.t("setup.bot." + ROOM_BOT + ".name") };
    } else if (mode === "bot") {
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
  const graded = mode === "room" ? w === seat : w !== null && !(mode === "bot" && w === 1);
  const g = $("overGrade");
  g.hidden = !graded;
  if (graded) g.textContent = I.t(["grade.bplus", "grade.a", "grade.aplus"][Math.min(2, Math.max(0, left - 1))]);
  overEl.hidden = false;
}

// ───────────────────────────── 輸入 ─────────────────────────────
function toLogical(e) {
  const r = cv.getBoundingClientRect();
  const x = ((e.clientX - r.left) * W) / r.width;
  const y = ((e.clientY - r.top) * H) / r.height;
  // 座位 1 的紙轉了 180°(CSS 只轉 canvas),輸入座標要轉回去。
  return sheetFlip ? { x: W - x, y: H - y } : { x, y };
}

function myTurn() {
  if (mode === "room") {
    // 輪到誰、還能不能出手,全部問伺服器最後那一則 state;送出去還沒回話的時候也不能再出手。
    return phase === "turn" && !sent && !!srv && srv.phase === "playing" && !!st && st.turn === seat;
  }
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
  if (mode === "room" && flashT > 0) {
    flashT -= dt;
    if (flashT <= 0) flashKey = null;
  }
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
  if (mode === "room") {
    banner(); // 倒數在跑:每一幀重算,有變才寫進 DOM
    renderRoom();
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

// canvas 的 CSS 大小交給樣式表(永遠撐滿框),這裡只配背後的像素、設好邏輯座標 = CSS px。
// 筆畫記的是「佔框的幾分之幾」,所以框變大變小,畫跟著縮放、不會消失,送進 toArt 的
// 也還是同一張畫。背後的像素還沒跟上時只是暫時模糊,位置和輸入座標都還是對的。
function renderPad(p) {
  const w = Math.max(1, Math.round(p.box.clientWidth));
  const h = Math.max(1, Math.round(p.box.clientHeight));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (p.cv.width !== pw || p.cv.height !== ph) {
    p.cv.width = pw;
    p.cv.height = ph;
  }
  const c = p.cv.getContext("2d");
  c.setTransform(pw / w, 0, 0, ph / h, 0, 0);
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
    syncDrawUI();
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
  syncDrawUI();
}

// 目前是哪一框(碰過、或剛被重畫清掉的那一框)要看得出來:框線換成那一邊的筆色,
// 其他兩框維持鉛筆色的虛線;沒有目前的框(還沒碰過任何框)時三框都一樣。
// 三框都空的時候「重畫」按不下去,有畫了(隨便哪一框)才亮起來。
function syncDrawUI() {
  pads.forEach((p, i) => {
    const active = i === activeBox;
    p.box.classList.toggle("active", active);
    p.box.classList.toggle("s0", active && drawSeat === 0);
    p.box.classList.toggle("s1", active && drawSeat === 1);
  });
  $("drawRedo").disabled = !pads.some((p) => p.strokes.length > 0);
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
  if (mode === "room") beginRoom();
  else beginPlay();
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
    const target = D.redoTarget(
      activeBox,
      pads.map((p) => p.strokes.length > 0)
    );
    if (target < 0) return;
    const p = pads[target];
    p.strokes = [];
    p.cur = null;
    renderPad(p);
    activeBox = target;
    syncDrawUI();
  });
  $("drawDefaults").addEventListener("click", () => finishDraw(true));
  $("drawDone").addEventListener("click", () => finishDraw(false));
  // 框自己變了就重畫,不等 window 的 resize:視窗縮放、轉向、字體載入完換行,
  // 都會改到框的大小,而其中有些根本不發 resize(手機轉向、桌機縮到窄的時候都遇過)。
  // canvas 的像素是 renderPad 照框現在的大小重設的,筆畫記的是「佔框的幾分之幾」,
  // 所以跟著縮放、不會消失,送進 toArt 的東西也不變。
  const repaint = () => {
    if (!$("draw").hidden) pads.forEach((p) => renderPad(p));
  };
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(repaint);
    pads.forEach((p) => ro.observe(p.box));
  } else {
    addEventListener("resize", repaint);
  }
}

// ───────────────────────────── 連線 ─────────────────────────────
// 這一節從頭到尾沒有一次 E.setup / E.apply:伺服器是唯一的真相。
// 它做的事只有四件:把畫面切到對的那一頁、把伺服器的 view 畫出來、把出手送出去、
// 把「連線現在怎麼了」翻譯成一行字。

const langParam = () => new URLSearchParams(location.search).get("lang");

// 提示和等人頁一秒會重算好幾十次(倒數在跑):算歸算,有變才寫進 DOM。
let bannerSig = null;
let roomSig = null;

// 換到 ?room=碼 那一頁(帶著玩家挑明的語言)。
function gotoRoom(c) {
  const u = new URL(location.href);
  u.hash = "";
  u.search = "";
  u.searchParams.set("room", c);
  const l = langParam();
  if (l) u.searchParams.set("lang", l);
  location.href = u.href;
}

// 開局頁那一區:開房間 / 房間碼 + 進去。
function bindSetup() {
  const err = $("setupErr");
  const show = (key) => {
    if (!err) return;
    err.textContent = key ? I.t(key) : "";
    err.hidden = !key;
  };
  const open = $("roomOpen");
  const input = $("roomCode");
  const join = $("roomJoin");
  if (open) open.addEventListener("click", () => gotoRoom(NET.genCode(Math.random)));
  const go = () => {
    const c = NET.normCode(input ? input.value : "");
    if (!c) {
      show("room.badcode"); // 不合格就停在這裡,不要送一個伺服器一定會退的碼出去
      return;
    }
    gotoRoom(c);
  };
  if (join) join.addEventListener("click", go);
  if (input) {
    input.addEventListener("input", () => show(null));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
  }
  return show;
}

function showPage(which) {
  $("draw").hidden = which !== "draw";
  if (roomEl) roomEl.hidden = which !== "room";
  $("stage").hidden = which !== "stage";
  bannerSig = null; // 換了一頁,提示要重寫一次(順便重算版面)
  roomSig = null;
  if (which === "stage") layout();
}

// 四個大字母。
function renderLetters() {
  const box = $("roomLetters");
  if (!box) return;
  box.textContent = "";
  for (const ch of code) {
    const s = document.createElement("span");
    s.textContent = ch;
    box.appendChild(s);
  }
}

function flash(key) {
  flashKey = key;
  flashT = FLASH_S;
}

// 對方還剩幾秒被電腦接手;沒有在倒數就回 null。
// 起點是「收到 online:false 那一則的伺服器 now」,一樣走 remainingMs,所以本機時鐘偏了也不影響。
function oppOffSec(now) {
  if (!offBase) return null;
  const ms = NET.remainingMs(offBase, offAt, now);
  return ms === null ? null : Math.ceil(ms / 1000);
}

// 連線模式的輪次提示。優先序:走不下去了 > 自己斷線 > 一句短訊息 > 對方斷線倒數 >
// 這一手的訊息 > 再來一張的狀態 > 輪到誰。
function roomBanner() {
  const now = Date.now();
  let text = " ";
  let cls = "df-turn";
  let alert = true;
  let side = -1;
  const off = oppOffSec(now);
  if (fatalKey) text = I.t(fatalKey);
  else if (netKey) text = I.t(netKey);
  else if (flashKey) text = I.t(flashKey);
  else if (off !== null) text = I.t("net.oppOffline", { sec: off });
  else if (msgKey) text = I.t(msgKey);
  else if (srv && srv.phase === "over") {
    const mine = srv.again[seat];
    const theirs = srv.again[1 - seat];
    alert = false;
    if (mine && !theirs) text = I.t("again.waiting");
    else if (theirs && !mine) text = I.t("again.oppWants");
  } else if (srv && srv.phase === "playing" && st) {
    alert = false;
    side = st.turn;
    if (st.turn === seat) {
      const left = NET.remainingMs(srv, srvAt, now);
      if (left !== null && left <= CLOCK_MS) {
        text = I.t("turn.clock", { sec: Math.ceil(left / 1000) });
        alert = true;
        side = -1;
      } else text = I.t("turn.you");
    } else {
      const opp = srv.seats[1 - seat];
      text =
        opp.kind === "bot"
          ? I.t("turn.bot", { name: I.t("setup.bot." + ROOM_BOT + ".name") })
          : I.t("turn.opp");
    }
  }
  if (alert && text !== " ") cls += " alert";
  else if (side >= 0) cls += " s" + side;
  const sig = cls + "|" + text;
  if (sig !== bannerSig) {
    bannerSig = sig;
    turnEl.className = cls;
    turnEl.textContent = text;
    layout();
  }
}

// 等人頁。每一幀問一次,有變才寫。
function renderRoom() {
  if (!roomEl || roomEl.hidden) return;
  const connecting = !srv;
  const waiting = !!srv && srv.phase === "waiting";
  const netText = fatalKey ? I.t(fatalKey) : netKey ? I.t(netKey) : connecting ? I.t("net.connecting") : "";
  const waitText = waiting ? I.t("room.waiting", { time: NET.mmss(Date.now() - waitFrom) }) : "";
  const sig = netText + "|" + waitText + "|" + (fatalKey ? "1" : "0") + "|" + (waiting ? "1" : "0");
  if (sig === roomSig) return;
  roomSig = sig;
  const net = $("roomNet");
  net.textContent = netText;
  net.hidden = !netText;
  $("roomWait").textContent = waitText;
  // 房間滿了:這一頁沒有路可走了,只留一條回開局頁的。四個字母和「告訴對面那個人」
  // 一起收掉——留著它們等於叫玩家去告訴別人一個他自己進不去的房間。
  roomEl.classList.toggle("full", !!fatalKey);
  $("roomLetters").hidden = !!fatalKey;
  $("roomCopy").hidden = !!fatalKey;
  $("roomSitin").hidden = !waiting;
  $("roomBack").hidden = !fatalKey;
}

// 伺服器送來一份 view:動畫還在播就先收著,播完(nextTurn)再吃。
function applyPending() {
  if (phase === "shot" || phase === "pause") return;
  if (pendingView === undefined) {
    syncRoom();
    return;
  }
  const v = pendingView;
  pendingView = undefined;
  const prev = st;
  if (!v) st = null; // 還在等人
  else if (prev && srv && srv.last && v.inks.length === prev.inks.length + 1) {
    // 剛好多一條線:把它畫出來。誰出的、是不是逾時代打,都照伺服器說的。
    const autoKey = srv.last.auto ? (srv.last.by === seat ? "msg.autoYou" : "msg.autoOpp") : null;
    animate(prev, v, srv.last.action.plane, null, autoKey);
    return;
  } else st = v; // 落後太多、或新的一局:直接跳過去,不硬演中間那幾手
  syncRoom();
}

// 把畫面切到伺服器說的那個 phase。
function syncRoom() {
  if (!srv) return;
  if (srv.phase === "over" && st) {
    showPage("stage");
    showOver();
    return;
  }
  if (overEl) overEl.hidden = true;
  phase = "turn";
  if (srv.phase === "playing" && st) {
    sheetFlip = seat === 1;
    if (sheetEl) sheetEl.classList.toggle("flip", sheetFlip);
    showPage("stage");
  } else {
    showPage("room");
  }
  banner();
}

function onState(msg, recvAt) {
  const before = srv ? srv.seats : null;
  const wasSeat = srv ? srv.seat : msg.seat;
  srv = msg;
  srvAt = recvAt;
  seat = msg.seat;
  sent = false;
  netKey = null;
  if (wasSeat !== msg.seat) bannerSig = null;

  // 對面那個座位怎麼了。
  const o = msg.seats[1 - seat];
  const p = before ? before[1 - seat] : null;
  if (p) {
    // 「電腦接手了」只在**真人的座位**被接手的時候說。空位變電腦是玩家自己按「讓班長頂上」
    // 的結果,對他說「接手」是答非所問(實測看到過)。
    if (o.kind === "bot" && p.kind === "human") flash("net.oppBot");
    // 回來了:斷線中的真人上線,或**電腦接手之後本人拿回座位**(後者才是最常見的那一種——
    // 實測過:只比對 human→human 的話,接手之後回來就一句話都不會出現)。
    // p.kind === "empty" 不算:那是第一次有人進來,畫面自己會開打。
    else if (o.kind === "human" && o.online && (p.kind === "bot" || (p.kind === "human" && !p.online))) flash("net.oppBack");
  }
  if (o.kind === "human" && !o.online) {
    if (!offBase) {
      offBase = { now: msg.now, deadline: msg.now + NET.OFFLINE_MS };
      offAt = recvAt;
    }
  } else {
    offBase = null;
  }

  pendingView = msg.view;
  applyPending();
  renderRoom();
}

// 伺服器退回一件事。房間不變,所以這裡也不要改畫面上的局面——只把「可以再出手了」打開。
function onError(codeStr) {
  sent = false;
  if (codeStr === "full") {
    fatalKey = "room.full";
    if (conn) conn.stop();
    showPage("room");
    renderRoom();
    banner();
  }
}

// sessionStorage 拿不到(無痕、被關掉)就回 null:net.js 的兩個函式都收得下。
function tokenStore() {
  try {
    return sessionStorage;
  } catch (_) {
    return null;
  }
}

function beginRoom() {
  token = NET.tokenFor(code, Math.random, tokenStore());
  renderLetters();
  const sitin = $("roomSitin");
  sitin.textContent = I.t("room.sitin", { name: I.t("setup.bot." + ROOM_BOT + ".name") });
  sitin.addEventListener("click", () => {
    if (conn) conn.send({ t: "bot" });
  });
  $("roomCopy").addEventListener("click", copyLink);
  waitFrom = Date.now();
  showPage("room");
  renderRoom();

  bindInput();
  addEventListener("resize", layout);
  if (window.visualViewport) visualViewport.addEventListener("resize", layout);
  $("again").addEventListener("click", () => {
    // 再撕一張是伺服器開的(兩邊都按才算),這裡只是舉手。
    if (conn) conn.send({ t: "again" });
    bannerSig = null;
    banner();
  });

  conn = new NET.Conn({
    url: () => NET.wsUrl(location, code),
    // 重連用**同一個 token**,所以拿得回座位;畫也一起再送一次(還沒開局的話還來得及換)。
    hello: () => ({ t: "hello", token, art: ART[0] }),
    onMsg: (msg, at) => {
      if (msg.t === "state") onState(msg, at);
      else if (msg.t === "error") onError(msg.code);
    },
    onUp: () => {
      netKey = null;
    },
    onDown: () => {
      // 還沒連上過就維持「連線中…」;連上過才是「斷線了」。
      netKey = srv ? "net.lost" : null;
    },
  });
  conn.start();
  // 分頁關掉 / 離開頁面:把線關乾淨(伺服器那邊馬上看到對方離線,不用等 TCP 逾時)。
  addEventListener("pagehide", () => {
    if (conn) conn.stop();
  });

  // 給驗證用的窗口(不是給玩家的)。連線模式沒有 seed、沒有 actions:客戶端本來就不該有。
  window.__dogfight = {
    record: () => ({
      mode: "room",
      code,
      seat,
      phase: srv ? srv.phase : "connecting",
      view: srv && srv.view ? E.clone(srv.view) : null,
      last: srv && srv.last ? E.clone(srv.last) : null,
    }),
  };

  requestAnimationFrame(frame);
}

// 複製的是整個連結(`…/dogfight/?room=碼`),不是四個字母:對方貼上就進得來。
function copyLink() {
  const btn = $("roomCopy");
  const link = NET.roomUrl(location, code, langParam());
  const done = () => {
    btn.textContent = I.t("room.copied");
    setTimeout(() => {
      btn.textContent = I.t("room.copy");
    }, 2000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(done, () => legacyCopy(link) && done());
    return;
  }
  if (legacyCopy(link)) done();
}

// 非安全來源(有些本機測試)沒有 clipboard API,退回老方法。兩個都不行就什麼都不說,
// 不要騙玩家「複製了」——四個字母還在畫面上,他念得出來。
function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const okCopy = document.execCommand("copy");
    document.body.removeChild(ta);
    return okCopy;
  } catch (_) {
    return false;
  }
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
  const room = q.get("room");
  // ?room=ABCD:連線。碼不合格就停在開局頁、指出哪裡不對,不要拿它去連一個不存在的房間。
  const roomCode = room === null ? null : NET.normCode(room);
  if (!(play && LEVELS.includes(play)) && !pair && !roomCode) {
    const showErr = bindSetup();
    if (room !== null) showErr("room.badcode");
    $("setup").hidden = false;
    return;
  }
  mode = roomCode ? "room" : pair ? "pair" : "bot";
  level = mode === "bot" ? play : null;
  if (roomCode) code = roomCode;
  document.body.classList.add("df-playing");

  C = P.tokens(["sheet", "rule", "pencil", "red", "blue", "black"]);
  C.side = [C.blue, C.black];
  reduced = P.reducedMotion();

  ART = loadArt();
  // 這個分頁已經有這個房間碼的 token = 它進過這個房間,現在是「回來的人」:跳過畫飛機、
  // 直接連線。重連的意思就是回來就拿回座位;每在畫飛機那一頁多停一秒,伺服器那邊就多算
  // 他離線一秒,20 秒一到電腦就替他打(orchestrator 裁決 #14,退回的那一則留言)。
  // 送出去的 art 沿用 localStorage 存的那一份——伺服器對回來的人本來就不看 art。
  // 第一次進這個房間(以及全新的分頁)還是先畫。
  if (mode === "room" && NET.savedToken(code, tokenStore())) {
    beginRoom();
    return;
  }
  setupDraw();
  startDraw(0);
}

main();
