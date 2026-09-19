// tests/acceptance.js — 紙上空戰的驗收。orchestrator 所有;peer 可以跑、可以拿它來弄紅,不編輯。
//
// SPEC 是從規則筆記(vault: Projects/bored_games/bored_games - rulebook.md)手抄的,
// 不從產品讀。第 0 組先拿產品的 RULES 來對 SPEC:改產品的數字讓行為測試變綠,會先在這裡爆。
import { section, check, eq, ok, nonEmpty } from "./harness.js";
import * as E from "../public/shared/dogfight/engine.js";

const SPEC = {
  W: 600,
  H: 900,
  FOLD: 450,
  PLANES: 3,
  SLOT_X: [120, 300, 480],
  SLOT_JITTER: 40,
  START_MIN: 90,
  START_MAX: 260,
  HIT: 24,
  MIN_LEN: 100,
  MAX_LEN: 740,
  LEN_ERR: 0.06,
  CURVE: 0.1,
  SAMPLES: 30,
  MAX_SHOTS: 30,
};
const SEEDS = Array.from({ length: 50 }, (_, i) => i * 7919 + 1);
const alive = (st, side) => st.planes.filter((p) => p.side === side && p.alive).length;

// 擺一個近距離的局面:座位 0 的 0 號在 (300,600),座位 1 的 3 號在正上方 dist 遠。
// 近距離時弧度和長度誤差加起來的側向偏移 < 命中半徑,所以「對準就一定中」是規則的推論,不是運氣。
function duel(seed, dist) {
  const st = E.setup(seed);
  const me = st.planes.find((p) => p.id === 0);
  const foe = st.planes.find((p) => p.id === 3);
  me.x = 300; me.y = 600;
  foe.x = 300; foe.y = 600 - dist;
  return st;
}
// 名目長度 len 對應的力道(用 SPEC 算,不用產品的數字)
const prFor = (len) => (len - SPEC.MIN_LEN) / (SPEC.MAX_LEN - SPEC.MIN_LEN);

section("0 常數對照");
for (const k of Object.keys(SPEC)) {
  check(`RULES.${k}`, () => eq(JSON.stringify(E.RULES[k]), JSON.stringify(SPEC[k]), k));
}
check("RULES 沒有 SPEC 不認得的欄位", () => {
  const extra = Object.keys(E.RULES).filter((k) => !(k in SPEC));
  return ok(extra.length === 0, extra.length ? `多出:${extra.join(",")}` : `${Object.keys(SPEC).length} 個欄位一一對上`);
});

section("1 產品動詞:擺得出一局,輪到的人有手可出,線會擊毀、會出界");
check("開局:每邊 3 架,都在自己那一半的起始帶裡", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st = E.setup(seed);
    if (st.planes.length !== SPEC.PLANES * 2) return `seed ${seed}: 飛機數 ${st.planes.length}`;
    for (const p of st.planes) {
      const k = p.id % SPEC.PLANES;
      const d = p.side === 0 ? SPEC.H - p.y : p.y;
      if (Math.abs(p.x - SPEC.SLOT_X[k]) > SPEC.SLOT_JITTER) return `seed ${seed} 飛機 ${p.id}: x=${p.x}`;
      if (d < SPEC.START_MIN || d > SPEC.START_MAX) return `seed ${seed} 飛機 ${p.id}: 離紙邊 ${d}`;
      if (!p.alive) return `seed ${seed} 飛機 ${p.id}: 開局就不是活的`;
      n++;
    }
    if (alive(st, 0) !== SPEC.PLANES || alive(st, 1) !== SPEC.PLANES) return `seed ${seed}: 兩邊不是各 ${SPEC.PLANES} 架`;
  }
  return ok(n === SEEDS.length * 6, `${SEEDS.length} 個種子、${n} 架飛機都在起始帶裡`);
});
check("開局:座位 0 先手,有 3 種手;還沒輪到的座位 1 沒有手", () => {
  const st = E.setup(1);
  const a = E.legal(st, 0).length, b = E.legal(st, 1).length;
  return ok(st.turn === 0 && a === 3 && b === 0, `turn=${st.turn} 座位0=${a} 手 座位1=${b} 手`);
});
check("出一手之後換座位 1,它有 3 種手", () => {
  const st = E.apply(E.setup(1), { type: "fire", plane: 0, ang: -Math.PI / 2, pr: 0 });
  const a = E.legal(st, 0).length, b = E.legal(st, 1).length;
  return ok(st.turn === 1 && a === 0 && b === 3, `turn=${st.turn} 座位0=${a} 手 座位1=${b} 手`);
});
check("對準 150 外的敵機、名目長度 200:每個種子都擊毀", () => {
  let kills = 0;
  for (const seed of SEEDS) {
    const st = E.apply(duel(seed, 150), { type: "fire", plane: 0, ang: -Math.PI / 2, pr: prFor(200) });
    const foe = st.planes.find((p) => p.id === 3);
    if (!foe.alive && foe.by === 0) kills++;
  }
  return ok(kills === SEEDS.length, `${kills} / ${SEEDS.length} 個種子擊毀`);
});
check("背對敵機出手:一架都不會毀(母體:同一批局面)", () => {
  const pop = nonEmpty(SEEDS.length, "種子"); if (pop !== true) return pop;
  let lost = 0;
  for (const seed of SEEDS) {
    const st = E.apply(duel(seed, 150), { type: "fire", plane: 0, ang: Math.PI / 2, pr: prFor(200) });
    lost += SPEC.PLANES - alive(st, 1);
  }
  return ok(lost === 0, `${SEEDS.length} 個種子,敵機共損失 ${lost} 架`);
});
check("出手的飛機移到線的盡頭:離原位 200 × (0.94 到 1.06)", () => {
  let lo = Infinity, hi = -Infinity;
  for (const seed of SEEDS) {
    const st = E.apply(duel(seed, 150), { type: "fire", plane: 0, ang: -Math.PI / 2, pr: prFor(200) });
    const me = st.planes.find((p) => p.id === 0);
    const d = Math.hypot(me.x - 300, me.y - 600);
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  // 弧度讓直線距離比線長略長,上限多給 1%
  return ok(lo >= 200 * 0.94 - 0.01 && hi <= 200 * 1.06 * 1.01 && hi - lo > 5, `最短 ${lo.toFixed(1)}、最長 ${hi.toFixed(1)}`);
});
check("全力朝紙外出手:那一架墜毀,其他兩架還在,換對方", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st = E.apply(E.setup(seed), { type: "fire", plane: 0, ang: Math.PI / 2, pr: 1 });
    const me = st.planes.find((p) => p.id === 0);
    if (me.alive || !me.lost) return `seed ${seed}: 飛到 (${me.x.toFixed(0)},${me.y.toFixed(0)}) 還活著`;
    if (alive(st, 0) !== 2 || st.turn !== 1 || st.over) return `seed ${seed}: 剩 ${alive(st, 0)} 架 turn=${st.turn} over=${st.over}`;
    n++;
  }
  return ok(n === SEEDS.length, `${n} / ${SEEDS.length} 個種子墜毀`);
});
check("自己的線穿過自己的飛機:不會毀", () => {
  const st0 = duel(1, 400);
  const mate = st0.planes.find((p) => p.id === 1);
  mate.x = 300; mate.y = 500;
  const st = E.apply(st0, { type: "fire", plane: 0, ang: -Math.PI / 2, pr: prFor(200) });
  const m = st.planes.find((p) => p.id === 1);
  return ok(m.alive, `線從 (300,600) 往上 200,隊友在 (300,500):alive=${m.alive} by=${m.by}`);
});
check("打掉對方最後一架:結束,出手的人贏", () => {
  const st0 = duel(1, 150);
  for (const p of st0.planes) if (p.side === 1 && p.id !== 3) p.alive = false;
  const st = E.apply(st0, { type: "fire", plane: 0, ang: -Math.PI / 2, pr: prFor(200) });
  return ok(st.over && st.winner === 0 && E.legal(st, 0).length === 0 && E.legal(st, 1).length === 0,
    `over=${st.over} winner=${st.winner}`);
});
check("不是自己的飛機、力道超出 0 到 1:拒絕", () => {
  const st = E.setup(1);
  let refused = 0;
  for (const a of [{ type: "fire", plane: 3, ang: 0, pr: 0.5 }, { type: "fire", plane: 0, ang: 0, pr: 1.2 }, { type: "fire", plane: 0, ang: NaN, pr: 0.5 }]) {
    try { E.apply(st, a); } catch (e) { refused++; }
  }
  return ok(refused === 3, `${refused} / 3 個不合法的手被拒絕`);
});
check("同一個種子、同一串手:兩次結果一模一樣;apply 不改到傳進來的 state", () => {
  const run = () => {
    let st = E.setup(42);
    for (let i = 0; i < 6 && !st.over; i++) {
      const m = E.legal(st, st.turn)[0];
      st = E.apply(st, { type: "fire", plane: m.plane, ang: st.turn === 0 ? -1.4 : 1.7, pr: 0.3 });
    }
    return JSON.stringify(st);
  };
  const before = E.setup(42), snap = JSON.stringify(before);
  E.apply(before, { type: "fire", plane: 0, ang: -1.4, pr: 0.3 });
  const same = run() === run(), untouched = JSON.stringify(before) === snap;
  return ok(same && untouched, `兩次重播相同=${same},輸入的 state 沒被動到=${untouched}`);
});

section("2 M1 要補的");
check("每人最多出手 30 次;到上限比剩下的飛機數,一樣多平手", () =>
  "TODO: 引擎還沒有出手上限(規則筆記未知數 #1)");
check("view(state, seat)", () => (typeof E.view === "function" ? true : "TODO: 還沒有 view;沒有隱藏資訊,但房間只送 view 的結果"));
check("合法手的 fuzz:隨機種子、隨機手,不當機、一定結束", () => "TODO: M1 的第二優先");
