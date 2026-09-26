// tests/acceptance.js — 紙上空戰的驗收。orchestrator 所有;peer 可以跑、可以拿它來弄紅,不編輯。
//
// SPEC 是從規則筆記(vault: Projects/bored_games/bored_games - rulebook.md)手抄的,
// 不從產品讀。第 0 組先拿產品的 RULES 來對 SPEC:改產品的數字讓行為測試變綠,會先在這裡爆。
import { section, check, eq, ok, nonEmpty, withSeed } from "./harness.js";
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
// 自己畫的飛機(規則筆記未知數 #4 和「自己畫的飛機」那張表):只影響外觀。
const SPEC_ART = { ART_STROKES: 16, ART_POINTS: 400 };
const SEEDS = Array.from({ length: 50 }, (_, i) => i * 7919 + 1);
// 誰先手是隨機的(owner 裁決 #4,2026-09-19)。要「座位 0 先出手」的列用 S0 指定;fuzz、bot 對打、重播用預設的(隨機)。
const S0 = (seed, opts) => E.setup(seed, { first: 0, ...opts });
const alive = (st, side) => st.planes.filter((p) => p.side === side && p.alive).length;

// 擺一個近距離的局面:座位 0 的 0 號在 (300,600),座位 1 的 3 號在正上方 dist 遠。
// 近距離時弧度和長度誤差加起來的側向偏移 < 命中半徑,所以「對準就一定中」是規則的推論,不是運氣。
function duel(seed, dist) {
  const st = S0(seed);
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
  const extra = Object.keys(E.RULES).filter((k) => !(k in SPEC) && !(k in SPEC_ART)); // SPEC_ART:自己畫的飛機(第 13 組)
  return ok(extra.length === 0, extra.length ? `多出:${extra.join(",")}` : `${Object.keys(SPEC).length} 個欄位一一對上`);
});

section("1 產品動詞:擺得出一局,輪到的人有手可出,線會擊毀、會出界");
check("開局:每邊 3 架,都在自己那一半的起始帶裡", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st = S0(seed);
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
check("指定座位 0 先手:它有 3 種手;還沒輪到的座位 1 沒有手", () => {
  const st = S0(1);
  const a = E.legal(st, 0).length, b = E.legal(st, 1).length;
  return ok(st.turn === 0 && a === 3 && b === 0, `turn=${st.turn} 座位0=${a} 手 座位1=${b} 手`);
});
check("出一手之後換座位 1,它有 3 種手", () => {
  const st = E.apply(S0(1), { type: "fire", plane: 0, ang: -Math.PI / 2, pr: 0 });
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
    const st = E.apply(S0(seed), { type: "fire", plane: 0, ang: Math.PI / 2, pr: 1 });
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
  const st = S0(1);
  let refused = 0;
  for (const a of [{ type: "fire", plane: 3, ang: 0, pr: 0.5 }, { type: "fire", plane: 0, ang: 0, pr: 1.2 }, { type: "fire", plane: 0, ang: NaN, pr: 0.5 }]) {
    try { E.apply(st, a); } catch (e) { refused++; }
  }
  return ok(refused === 3, `${refused} / 3 個不合法的手被拒絕`);
});
check("同一個種子、同一串手:兩次結果一模一樣;apply 不改到傳進來的 state", () => {
  const run = () => {
    let st = S0(42);
    for (let i = 0; i < 6 && !st.over; i++) {
      const m = E.legal(st, st.turn)[0];
      st = E.apply(st, { type: "fire", plane: m.plane, ang: st.turn === 0 ? -1.4 : 1.7, pr: 0.3 });
    }
    return JSON.stringify(st);
  };
  const before = S0(42), snap = JSON.stringify(before);
  E.apply(before, { type: "fire", plane: 0, ang: -1.4, pr: 0.3 });
  const same = run() === run(), untouched = JSON.stringify(before) === snap;
  return ok(same && untouched, `兩次重播相同=${same},輸入的 state 沒被動到=${untouched}`);
});

// ───────────────────────────── M1 ─────────────────────────────
// 以下的期望值一樣只從規則筆記來。要動到 M1 才有的東西(出手上限、view、replay、onPaper)的列,
// 在引擎還沒匯出這三個函式之前是「尚未實作」;三個都匯出之後就全部當真,做錯就是紅的。
const M1_MISSING = ["view", "replay", "onPaper"].filter((k) => typeof E[k] !== "function");
const M1 = M1_MISSING.length === 0;
const m1todo = () => `TODO: 引擎還沒有 ${M1_MISSING.join("、")}(M1)`;

const fire = (st, plane, ang, pr) => E.apply(st, { type: "fire", plane, ang, pr });
const lastInk = (st) => st.inks[st.inks.length - 1];
const plane = (st, id) => st.planes.find((p) => p.id === id);
const inside = (p) => p.x >= 0 && p.x <= SPEC.W && p.y >= 0 && p.y <= SPEC.H; // 未知數 #7:含邊
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };
// 把飛機擺到指定位置(測試的慣用手法,跟 duel 一樣):{id: [x, y] | null(null = 已經毀了)}
function place(st, spots) {
  for (const [id, v] of Object.entries(spots)) {
    const p = plane(st, +id);
    if (v === null) { p.alive = false; p.by = 1 - p.side; } else { p.x = v[0]; p.y = v[1]; }
  }
  return st;
}
// 把一條線拆回規則筆記的量:沿出手方向的距離 along、側向偏移 lat。
// 回傳 {len, ratio(對名目長度), curv, shapeErr(31 點離「s·len、curv·len·s²」最遠多少)}
function measure(pts, x0, y0, ang, pr) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const al = pts.map((q) => (q.x - x0) * c + (q.y - y0) * s);
  const la = pts.map((q) => -(q.x - x0) * s + (q.y - y0) * c);
  const n = pts.length - 1, len = al[n], curv = la[n] / len;
  let shapeErr = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    shapeErr = Math.max(shapeErr, Math.abs(al[i] - t * len), Math.abs(la[i] - curv * len * t * t));
  }
  return { len, ratio: len / (SPEC.MIN_LEN + (SPEC.MAX_LEN - SPEC.MIN_LEN) * pr), curv, shapeErr };
}
// 均勻分布的粗檢查:切四等分,每一份要有 15% 到 35%
function quartiles(xs, lo, hi) {
  const b = [0, 0, 0, 0];
  for (const x of xs) b[Math.min(3, Math.max(0, Math.floor(((x - lo) / (hi - lo)) * 4)))]++;
  return b.map((k) => k / xs.length);
}
const MANY = Array.from({ length: 200 }, (_, i) => i * 104729 + 17);

section("2 數值表:開局");
check("起始朝向:朝對方(座位 0 朝上 −π/2,座位 1 朝下 +π/2);shots [0,0]、沒有墨跡、還沒結束", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st = E.setup(seed);
    for (const p of st.planes) {
      const want = p.side === 0 ? -Math.PI / 2 : Math.PI / 2;
      if (angDiff(p.ang, want) > 1e-9) return `seed ${seed} 飛機 ${p.id}: ang=${p.ang}`;
      if ((p.side === 0) !== (p.y > SPEC.FOLD)) return `seed ${seed} 飛機 ${p.id}: side ${p.side} 卻在 y=${p.y}(摺線 ${SPEC.FOLD})`;
      n++;
    }
    if (JSON.stringify(st.shots) !== "[0,0]" || st.inks.length !== 0 || st.over || st.winner !== null)
      return `seed ${seed}: shots=${JSON.stringify(st.shots)} inks=${st.inks.length} over=${st.over} winner=${st.winner}`;
  }
  return ok(n === SEEDS.length * 6, `${n} 架飛機的朝向都對`);
});
check("起始位置真的是隨機的:x 抖動和離紙邊的距離都用到大半個範圍;同種子同局面、不同種子不同局面", () => {
  let jl = Infinity, jh = -Infinity, dl = Infinity, dh = -Infinity;
  const seen = new Set();
  for (const seed of SEEDS) {
    const st = E.setup(seed);
    if (JSON.stringify(st) !== JSON.stringify(E.setup(seed))) return `seed ${seed}: 兩次 setup 不一樣`;
    seen.add(JSON.stringify(st.planes));
    for (const p of st.planes) {
      const j = p.x - SPEC.SLOT_X[p.id % SPEC.PLANES], d = p.side === 0 ? SPEC.H - p.y : p.y;
      jl = Math.min(jl, j); jh = Math.max(jh, j); dl = Math.min(dl, d); dh = Math.max(dh, d);
    }
  }
  return ok(jl < -30 && jh > 30 && dl < 110 && dh > 240 && seen.size === SEEDS.length,
    `x 抖動 ${jl.toFixed(1)} 到 ${jh.toFixed(1)}(±40),離紙邊 ${dl.toFixed(1)} 到 ${dh.toFixed(1)}(90 到 260),${seen.size} / ${SEEDS.length} 種局面`);
});

section("3 數值表:出手");
// 每個種子出一手,方向跟著種子變(不只測正上方),量那條墨跡。
function sampleShots(pr) {
  return MANY.map((seed) => {
    const st0 = S0(seed), me = plane(st0, 1), ang = ((seed % 6283) / 1000) - Math.PI;
    const st = fire(st0, 1, ang, pr);
    return { seed, n: lastInk(st).pts.length, p0: lastInk(st).pts[0], x0: me.x, y0: me.y, ...measure(lastInk(st).pts, me.x, me.y, ang, pr) };
  });
}
check("線有 31 個取樣點,第一點就是飛機出手前的位置", () => {
  let n = 0;
  for (const pr of [0, 0.5, 1]) for (const m of sampleShots(pr)) {
    if (m.n !== SPEC.SAMPLES + 1) return `seed ${m.seed} pr=${pr}: ${m.n} 點`;
    if (Math.hypot(m.p0.x - m.x0, m.p0.y - m.y0) > 1e-9) return `seed ${m.seed}: 第一點 (${m.p0.x},${m.p0.y}) 不是飛機的位置 (${m.x0},${m.y0})`;
    n++;
  }
  return ok(n === MANY.length * 3, `${n} 條線,每條 31 點`);
});
check("名目長度 100 + 640 × pr(pr=0 → 100,pr=1 → 740);誤差 × 0.94 到 1.06,均勻", () => {
  const all = [], per = [];
  for (const pr of [0, 0.25, 0.5, 1]) {
    const r = sampleShots(pr).map((m) => m.ratio);
    const lo = Math.min(...r), hi = Math.max(...r);
    if (lo < 1 - SPEC.LEN_ERR - 1e-9 || hi > 1 + SPEC.LEN_ERR + 1e-9) return `pr=${pr}: 線長 / 名目 = ${lo.toFixed(4)} 到 ${hi.toFixed(4)},超出 0.94 到 1.06`;
    if (lo > 0.945 || hi < 1.055) return `pr=${pr}: 線長 / 名目只有 ${lo.toFixed(4)} 到 ${hi.toFixed(4)},沒用到整個 ±6%`;
    per.push(`pr=${pr}: ${(lo * (100 + 640 * pr)).toFixed(0)} 到 ${(hi * (100 + 640 * pr)).toFixed(0)}`);
    all.push(...r);
  }
  const mean = all.reduce((a, b) => a + b, 0) / all.length, q = quartiles(all, 0.94, 1.06);
  return ok(Math.abs(mean - 1) < 0.005 && q.every((f) => f > 0.15 && f < 0.35),
    `${per.join(";")};平均倍率 ${mean.toFixed(4)},四等分 ${q.map((f) => (f * 100).toFixed(0) + "%").join(" ")}`);
});
check("弧度:每一點的側向偏移 = curv × len × s²,沿線距離 = s × len;curv 在 ±0.10,均勻、兩邊都有", () => {
  const cs = [];
  let worst = 0;
  for (const pr of [0, 0.5, 1]) for (const m of sampleShots(pr)) {
    if (Math.abs(m.curv) > SPEC.CURVE + 1e-9) return `seed ${m.seed} pr=${pr}: curv=${m.curv.toFixed(4)}`;
    worst = Math.max(worst, m.shapeErr);
    cs.push(m.curv);
  }
  const lo = Math.min(...cs), hi = Math.max(...cs), q = quartiles(cs, -0.1, 0.1);
  return ok(worst < 1e-6 && lo < -0.09 && hi > 0.09 && q.every((f) => f > 0.15 && f < 0.35),
    `${cs.length} 條線:curv ${lo.toFixed(4)} 到 ${hi.toFixed(4)},四等分 ${q.map((f) => (f * 100).toFixed(0) + "%").join(" ")},形狀最大誤差 ${worst.toExponential(1)}`);
});
check("命中半徑 24(不到半徑才算):起點旁 23.99 的敵機毀,剛好 24 的不毀", () => {
  let hit = 0, miss = 0;
  for (const seed of SEEDS) {
    const a = fire(place(S0(seed), { 0: [300, 600], 3: [300 + 23.99, 600] }), 0, -Math.PI / 2, 0);
    const b = fire(place(S0(seed), { 0: [300, 600], 3: [300 + 24, 600] }), 0, -Math.PI / 2, 0);
    if (!plane(a, 3).alive) hit++;
    if (plane(b, 3).alive) miss++;
  }
  return ok(hit === SEEDS.length && miss === SEEDS.length, `23.99:${hit} / ${SEEDS.length} 毀;24:${miss} / ${SEEDS.length} 沒事`);
});
check("命中半徑 24:線中段(沿線 50)旁邊 20 的一定毀,旁邊 27 的一定不毀", () => {
  // pr=0:線長 94 到 106,取樣間距 ≤ 3.6,沿線 50 處的弧度偏移 ≤ 2.7。20 → 最遠 22.8 < 24;27 → 最近 24.3 > 24。
  let hit = 0, miss = 0;
  for (const seed of SEEDS) for (const side of [-1, 1]) {
    const a = fire(place(S0(seed), { 0: [300, 600], 3: [300 + side * 20, 550] }), 0, -Math.PI / 2, 0);
    const b = fire(place(S0(seed), { 0: [300, 600], 3: [300 + side * 27, 550] }), 0, -Math.PI / 2, 0);
    if (!plane(a, 3).alive && plane(a, 3).by === 0) hit++;
    if (plane(b, 3).alive) miss++;
  }
  return ok(hit === SEEDS.length * 2 && miss === SEEDS.length * 2, `旁邊 20:${hit} / ${SEEDS.length * 2} 毀;旁邊 27:${miss} / ${SEEDS.length * 2} 沒事`);
});
check("一條線可以毀掉不只一架:正前方 100 和 200 各一架、名目長度 600,兩架都毀,遠處那架沒事", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st = fire(place(S0(seed), { 0: [300, 850], 3: [300, 750], 4: [300, 650], 5: [560, 40] }), 0, -Math.PI / 2, prFor(600));
    const d = [3, 4, 5].map((id) => plane(st, id));
    if (d[0].alive || d[1].alive || !d[2].alive || d[0].by !== 0 || d[1].by !== 0) return `seed ${seed}: 3 號 alive=${d[0].alive}、4 號 alive=${d[1].alive}、5 號 alive=${d[2].alive}`;
    n++;
  }
  return ok(n === SEEDS.length, `${n} / ${SEEDS.length} 個種子一線兩架`);
});
check("殘骸不擋線(未知數 #2):前面那架早就毀了,後面那架照樣被打到;殘骸留在原地", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st0 = place(S0(seed), { 0: [300, 850], 3: [300, 750], 4: [300, 650], 5: [560, 40] });
    place(st0, { 3: null });
    const st = fire(st0, 0, -Math.PI / 2, prFor(600));
    const w = plane(st, 3), t = plane(st, 4);
    if (t.alive) return `seed ${seed}: 殘骸後面的 4 號沒被打到`;
    if (w.alive || w.x !== 300 || w.y !== 750) return `seed ${seed}: 殘骸變了 alive=${w.alive} (${w.x},${w.y})`;
    n++;
  }
  return ok(n === SEEDS.length, `${n} / ${SEEDS.length} 個種子,線穿過殘骸打到後面`);
});
check("每次出手留下一條墨跡,之前的不會變;墨跡純裝飾(未知數 #3):把墨跡擦掉再出同一手,結果一樣", () => {
  let st = S0(7), n = 0;
  const moves = [[1, -1.2, 0.1], [4, 1.9, 0.1], [1, -2.0, 0.2], [4, 1.1, 0.2], [0, -1.5, 0.3]];
  for (const [id, ang, pr] of moves) {
    const bare = { ...clone(st), inks: [] };
    const next = fire(st, id, ang, pr), nextBare = fire(bare, id, ang, pr);
    if (next.inks.length !== st.inks.length + 1) return `第 ${n + 1} 手之後墨跡 ${next.inks.length} 條`;
    if (JSON.stringify(next.inks.slice(0, -1)) !== JSON.stringify(st.inks)) return `第 ${n + 1} 手改到舊的墨跡`;
    if (lastInk(next).side !== plane(st, id).side) return `第 ${n + 1} 手的墨跡 side=${lastInk(next).side}`;
    const strip = (s) => JSON.stringify({ ...s, inks: 0 });
    if (strip(next) !== strip(nextBare)) return `第 ${n + 1} 手:有墨跡和沒墨跡的結果不一樣`;
    st = next; n++;
  }
  return ok(n === moves.length && !st.over, `${n} 手、${st.inks.length} 條墨跡;擦掉墨跡結果不變`);
});
function clone(x) { return JSON.parse(JSON.stringify(x)); }

section("4 數值表:回合");
check("力道含兩端(0 和 1 可以,−0.001 和 1.001 不行);方向任意有限角度;自己已經毀掉的飛機不能出手;被拒絕的手不動到 state", () => {
  const st = place(S0(3), { 2: null });
  const snap = JSON.stringify(st);
  const good = [[0, -1.5, 0], [0, -1.5, 1], [0, 7.5, 0.2], [0, -20, 0.2]].filter(([id, a, pr]) => !throws(() => fire(st, id, a, pr))).length;
  const bad = [[0, -1.5, -0.001], [0, -1.5, 1.001], [0, Infinity, 0.5], [0, -1.5, NaN], [2, -1.5, 0.5], [4, 1.5, 0.5], [9, 0, 0.5]]
    .filter(([id, a, pr]) => throws(() => fire(st, id, a, pr))).length;
  const badType = throws(() => E.apply(st, { type: "pass" })) && throws(() => E.apply(st, null));
  return ok(good === 4 && bad === 7 && badType && JSON.stringify(st) === snap, `合法 ${good} / 4 接受,不合法 ${bad} / 7 拒絕,怪動作拒絕=${badType},state 沒被動到=${JSON.stringify(st) === snap}`);
});
check("出手後的朝向 = 線尾的方向(跟出手方向差不到 atan(0.2) ≈ 11.3°,而且真的會偏)", () => {
  let worst = 0, tail = 0;
  for (const seed of SEEDS) {
    const ang = ((seed % 6283) / 1000) - Math.PI;
    const st = fire(place(S0(seed), { 1: [300, 450] }), 1, ang, 0.1);
    const pts = lastInk(st).pts, me = plane(st, 1);
    const want = Math.atan2(pts[30].y - pts[29].y, pts[30].x - pts[29].x);
    tail = Math.max(tail, angDiff(me.ang, want));
    worst = Math.max(worst, angDiff(me.ang, ang));
  }
  return ok(tail < 1e-9 && worst < Math.atan(0.2) + 1e-6 && worst > 0.1, `跟線尾方向最多差 ${tail.toExponential(1)};跟出手方向最多差 ${(worst * 180 / Math.PI).toFixed(1)}°`);
});
check("飛機可以停在對方那一半,下一輪從那裡再出手(未知數 #6)", () => {
  let n = 0;
  for (const seed of SEEDS) {
    let st = fire(place(S0(seed), { 0: [300, 600], 3: [60, 60], 4: [540, 60], 5: [60, 200] }), 0, -Math.PI / 2, prFor(400));
    const me = plane(st, 0);
    if (!me.alive || me.y >= SPEC.FOLD) return `seed ${seed}: 停在 y=${me.y.toFixed(0)} alive=${me.alive}`;
    st = fire(st, 3, 0, 0);
    if (!E.legal(st, 0).some((m) => m.plane === 0)) return `seed ${seed}: 在對方那一半的飛機沒有手`;
    const from = lastInk(fire(st, 0, 0, 0)).pts[0];
    if (Math.hypot(from.x - me.x, from.y - me.y) > 1e-9) return `seed ${seed}: 下一手不是從停下來的地方出發`;
    n++;
  }
  return ok(n === SEEDS.length, `${n} / ${SEEDS.length} 個種子:停在摺線另一邊,還能再出手`);
});
check("擊毀和墜毀的記號:被打到的 by = 出手的座位、lost = false;飛出紙外的 lost = true、by = null", () => {
  const st = fire(place(S0(5), { 0: [300, 120], 3: [300, 60] }), 0, -Math.PI / 2, 1);
  const me = plane(st, 0), foe = plane(st, 3);
  return ok(!me.alive && me.lost && me.by === null && !foe.alive && foe.by === 0 && foe.lost === false,
    `出手的:alive=${me.alive} lost=${me.lost} by=${me.by};被打的:alive=${foe.alive} lost=${foe.lost} by=${foe.by}`);
});
check("紙邊算在紙上(未知數 #7):onPaper 在 x ∈ [0,600]、y ∈ [0,900] 含邊", () => {
  if (!M1) return m1todo();
  const on = [[0, 0], [600, 900], [0, 900], [600, 0], [300, 0], [0, 450], [300, 450]].filter(([x, y]) => E.onPaper({ x, y }) === true).length;
  const off = [[-0.001, 450], [600.001, 450], [300, -0.001], [300, 900.001], [-5, -5], [NaN, 5]].filter(([x, y]) => E.onPaper({ x, y }) === false).length;
  return ok(on === 7 && off === 6, `紙上 ${on} / 7,紙外 ${off} / 6`);
});

section("5 勝負");
check("同一手打光對方、自己那架也飛出紙外:出手的人贏", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st = fire(place(S0(seed), { 0: [300, 120], 1: null, 2: null, 3: [300, 60], 4: null, 5: null }), 0, -Math.PI / 2, 1);
    if (!(st.over && st.winner === 0 && !plane(st, 0).alive && !plane(st, 3).alive)) return `seed ${seed}: over=${st.over} winner=${st.winner} 我=${plane(st, 0).alive} 敵=${plane(st, 3).alive}`;
    n++;
  }
  return ok(n === SEEDS.length, `${n} / ${SEEDS.length} 個種子:兩邊都沒飛機了,出手的座位 0 贏`);
});
check("自己最後一架飛出紙外、對方還有飛機:對方贏;結束之後誰都沒有手,再出手會被拒絕", () => {
  const st = fire(place(S0(9), { 0: null, 1: null }), 2, Math.PI / 2, 1);
  const dead = throws(() => fire(st, 3, 1.5, 0.1));
  return ok(st.over && st.winner === 1 && E.legal(st, 0).length === 0 && E.legal(st, 1).length === 0 && dead,
    `over=${st.over} winner=${st.winner},結束後出手被拒絕=${dead}`);
});

section("6 出手上限(未知數 #1)");
// 兩邊各派一架在自己那一排來回挪(pr=0,一次往東一次往西),誰也打不到誰,一路耗到上限。
function shuffle(st, n) {
  for (let i = 0; i < n; i++) {
    if (st.over) return st;
    const side = st.turn, id = side === 0 ? 1 : 4;
    st = fire(st, id, st.shots[side] % 2 === 0 ? 0 : Math.PI, 0);
  }
  return st;
}
const capStart = (seed, spots = {}) => place(S0(seed), { 1: [300, 700], 4: [300, 200], ...spots });
const CAP_SEEDS = [1, 2, 3, 4, 5];
check("打滿才結束:第 59 手之後還在打(輪到座位 1 的第 30 次),第 60 手之後結束;3 對 3 平手 = over 而且 winner 是 null", () => {
  if (!M1) return m1todo();
  for (const seed of CAP_SEEDS) {
    const a = shuffle(capStart(seed), 59);
    if (a.planes.some((p) => !p.alive)) return `seed ${seed}: 前置不成立,來回挪的時候有飛機毀了`;
    if (a.over || a.turn !== 1 || JSON.stringify(a.shots) !== "[30,29]" || E.legal(a, 1).length !== 3)
      return `seed ${seed}: 59 手之後 over=${a.over} turn=${a.turn} shots=${JSON.stringify(a.shots)} 座位1=${E.legal(a, 1).length} 手`;
    const b = shuffle(a, 1);
    if (!(b.over && b.winner === null && JSON.stringify(b.shots) === "[30,30]")) return `seed ${seed}: 60 手之後 over=${b.over} winner=${b.winner} shots=${JSON.stringify(b.shots)}`;
    if (E.legal(b, 0).length || E.legal(b, 1).length || !throws(() => fire(b, 1, 0, 0))) return `seed ${seed}: 結束之後還能出手`;
  }
  return ok(true, `${CAP_SEEDS.length} 個種子:59 手 shots=[30,29] 還沒結束,60 手 shots=[30,30] 平手`);
});
check("到上限比剩下的飛機:3 對 2 座位 0 贏,2 對 3 座位 1 贏,2 對 2、1 對 1 平手", () => {
  if (!M1) return m1todo();
  const cases = [[{ 5: null }, 0], [{ 0: null }, 1], [{ 0: null, 5: null }, null], [{ 0: null, 2: null, 3: null, 5: null }, null], [{ 0: null, 2: null }, 1]];
  const got = [];
  for (const [spots, want] of cases) for (const seed of CAP_SEEDS) {
    const st = shuffle(capStart(seed, spots), 60);
    if (JSON.stringify(st.shots) !== "[30,30]") return `seed ${seed}: 前置不成立 shots=${JSON.stringify(st.shots)}`;
    if (!st.over || st.winner !== want) return `seed ${seed} ${alive(st, 0)} 對 ${alive(st, 1)}: over=${st.over} winner=${st.winner},應該是 ${want}`;
    if (seed === 1) got.push(`${alive(st, 0)} 對 ${alive(st, 1)} → ${st.winner}`);
  }
  return ok(got.length === cases.length, got.join(";"));
});
check("第 60 手打掉一架:先算這一手的戰果再比數量(3 對 3 → 2 對 3,出手的座位 1 贏)", () => {
  if (!M1) return m1todo();
  for (const seed of CAP_SEEDS) {
    const a = place(shuffle(capStart(seed), 59), { 0: [100, 500], 5: [100, 350] });
    const b = fire(a, 5, Math.PI / 2, prFor(200));
    if (!(b.over && b.winner === 1 && alive(b, 0) === 2 && alive(b, 1) === 3)) return `seed ${seed}: over=${b.over} winner=${b.winner} ${alive(b, 0)} 對 ${alive(b, 1)}`;
  }
  return ok(true, `${CAP_SEEDS.length} 個種子:最後一手擊毀一架,2 對 3,座位 1 贏`);
});
check("第 60 手同時打光對方、自己最後一架也出界:出手的人贏,不是 0 對 0 平手", () => {
  if (!M1) return m1todo();
  for (const seed of CAP_SEEDS) {
    const a = place(shuffle(capStart(seed), 59), { 0: null, 2: null, 3: null, 5: null, 4: [300, 780], 1: [300, 840] });
    const b = fire(a, 4, Math.PI / 2, 1);
    if (alive(b, 0) !== 0 || alive(b, 1) !== 0) return `seed ${seed}: 前置不成立,${alive(b, 0)} 對 ${alive(b, 1)}`;
    if (!(b.over && b.winner === 1)) return `seed ${seed}: over=${b.over} winner=${b.winner}`;
  }
  return ok(true, `${CAP_SEEDS.length} 個種子:0 對 0,出手的座位 1 贏`);
});

section("7 view");
check("view(state, seat):兩個座位都看到整張紙(turn、shots、planes、inks、over、winner),而且是一份拷貝", () => {
  if (!M1) return m1todo();
  const states = [S0(11), shuffle(capStart(11), 7), fire(place(S0(9), { 0: null, 1: null }), 2, Math.PI / 2, 1)];
  let n = 0;
  for (const st of states) for (const seat of [0, 1]) {
    const snap = JSON.stringify(st), v = E.view(st, seat);
    for (const k of ["turn", "shots", "planes", "inks", "over", "winner"])
      if (JSON.stringify(v[k]) !== JSON.stringify(st[k])) return `seat ${seat}: view.${k} 跟 state 不一樣`;
    v.planes[0].x = -999; v.shots[0] = 99; if (v.inks[0]) v.inks[0].pts[0].x = -999;
    if (JSON.stringify(st) !== snap) return `seat ${seat}: 改 view 的結果動到了 state`;
    n++;
  }
  return ok(n === 6, `${n} 個 view(開局、打到一半、結束 × 兩個座位)都對得上,改它不會動到 state`);
});

// ───────────────────────────── fuzz ─────────────────────────────
// 測試自己的亂數(不碰 Math.random),每一局一個種子。三種打法:
//   wild  方向、力道全隨機(多半自己飛出去)
//   timid 力道很小、往自己那一半的中間挪(耗到出手上限)
//   aim   朝一架敵機瞄、帶一點誤差(會擊毀、會打光)
function rng32(seed) {
  let x = (seed >>> 0) || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}
function pick(st, r, policy) {
  const ms = E.legal(st, st.turn), m = ms[Math.floor(r() * ms.length)];
  let ang = m.ang[0] + r() * (m.ang[1] - m.ang[0]), pr = m.pr[0] + r() * (m.pr[1] - m.pr[0]);
  if (policy === "timid") { // 小力道、大致朝自己那一半的中間挪,才耗得到上限(全隨機的方向會先走出紙外)
    const me = plane(st, m.plane);
    ang = Math.atan2((me.side === 0 ? 675 : 225) - me.y, 300 - me.x) + (r() * 2 - 1) * 0.9;
    return { type: "fire", plane: m.plane, ang, pr: r() * 0.06 };
  }
  if (policy === "aim") {
    const me = plane(st, m.plane), foes = st.planes.filter((p) => p.side !== me.side && p.alive), f = foes[Math.floor(r() * foes.length)];
    ang = Math.atan2(f.y - me.y, f.x - me.x) + (r() * 2 - 1) * 0.15;
    pr = Math.min(1, Math.max(0, prFor(Math.hypot(f.x - me.x, f.y - me.y) + 40) + (r() * 2 - 1) * 0.1));
  }
  if (r() < 0.05) pr = r() < 0.5 ? 0 : 1;
  return { type: "fire", plane: m.plane, ang, pr };
}
// 一手的神諭:只用 SPEC 和那條墨跡,重算這一手之後 state 應該長什麼樣。回傳錯誤字串或 null。
function judge(prev, a, next, stats) {
  const side = prev.turn, foe = 1 - side, ink = lastInk(next);
  if (next.inks.length !== prev.inks.length + 1 || ink.side !== side || ink.pts.length !== SPEC.SAMPLES + 1) return "墨跡沒有剛好多一條 31 點的";
  if (next.seed !== prev.seed || next.planes.length !== 6) return "seed 或飛機數變了";
  const me0 = plane(prev, a.plane), m = measure(ink.pts, me0.x, me0.y, a.ang, a.pr);
  if (!(m.ratio >= 0.94 - 1e-9 && m.ratio <= 1.06 + 1e-9 && Math.abs(m.curv) <= 0.1 + 1e-9 && m.shapeErr < 1e-6)) return `線不合規則:倍率 ${m.ratio} curv ${m.curv} 形狀誤差 ${m.shapeErr}`;
  let kills = 0;
  for (const p0 of prev.planes) {
    const p1 = plane(next, p0.id);
    if (p0.id === a.plane) {
      const end = ink.pts[SPEC.SAMPLES], out = !inside(end);
      if (p1.x !== end.x || p1.y !== end.y) return `出手的飛機沒有停在線的盡頭`;
      if (p1.alive !== !out || p1.lost !== out || p1.by !== null || p1.side !== side) return `出手的飛機 盡頭 (${end.x.toFixed(1)},${end.y.toFixed(1)}) alive=${p1.alive} lost=${p1.lost} by=${p1.by}`;
      if (!Number.isFinite(p1.ang)) return `朝向不是數字`;
      if (out) stats.crashes++;
    } else if (p0.side === foe && p0.alive) {
      const hit = ink.pts.some((q) => Math.hypot(q.x - p0.x, q.y - p0.y) < SPEC.HIT);
      if (p1.alive === hit) return `敵機 ${p0.id}:線${hit ? "有" : "沒有"}進到 24 以內,alive=${p1.alive}`;
      if (JSON.stringify({ ...p1, alive: 0, by: 0 }) !== JSON.stringify({ ...p0, alive: 0, by: 0 }) || p1.by !== (hit ? side : null)) return `敵機 ${p0.id} 的其他欄位變了,或 by=${p1.by}`;
      if (hit) kills++;
    } else if (JSON.stringify(p1) !== JSON.stringify(p0)) return `飛機 ${p0.id}(隊友或殘骸)不該變`;
  }
  stats.kills += kills; if (kills > 1) stats.multi++;
  const shots = prev.shots.slice(); shots[side]++;
  if (JSON.stringify(next.shots) !== JSON.stringify(shots) || shots[0] > SPEC.MAX_SHOTS || shots[1] > SPEC.MAX_SHOTS) return `shots ${JSON.stringify(prev.shots)} → ${JSON.stringify(next.shots)}`;
  const left = [alive(next, 0), alive(next, 1)];
  let over = false, winner = null, why = null;
  if (left[foe] === 0) { over = true; winner = side; why = "wipe"; }
  else if (left[side] === 0) { over = true; winner = foe; why = "crash"; }
  else if (shots[0] >= SPEC.MAX_SHOTS && shots[1] >= SPEC.MAX_SHOTS) {
    if (!M1) return null; // 上限還沒做:這一格留給「一定結束」那一列
    over = true; winner = left[0] === left[1] ? null : left[0] > left[1] ? 0 : 1; why = "cap";
  }
  if (next.over !== over || next.winner !== winner) return `${left[0]} 對 ${left[1]}、shots ${JSON.stringify(shots)}:應該 over=${over} winner=${winner},實際 over=${next.over} winner=${next.winner}`;
  if (over) { stats.ends[why]++; if (E.legal(next, 0).length || E.legal(next, 1).length) return "結束了還有合法的手"; }
  else {
    if (next.turn !== foe) return `沒有換人:turn=${next.turn}`;
    if (E.legal(next, foe).length !== left[foe] || E.legal(next, side).length !== 0) return `合法手的數量不對:輪到的 ${E.legal(next, foe).length}(活著 ${left[foe]}),沒輪到的 ${E.legal(next, side).length}`;
  }
  return null;
}
let FUZZ = null;
function fuzz() {
  if (FUZZ) return FUZZ;
  const stats = { games: 0, shots: 0, kills: 0, multi: 0, crashes: 0, refused: 0, ends: { wipe: 0, crash: 0, cap: 0 }, unfinished: 0, err: null, records: [] };
  outer: for (const policy of ["wild", "timid", "aim"]) for (let g = 0; g < 40; g++) {
    const seed = 1000 + g * 7717 + policy.length, r = rng32(seed * 31 + 7);
    let st = E.setup(seed);
    const actions = [], trail = [];
    for (let i = 0; i < 2 * SPEC.MAX_SHOTS && !st.over; i++) {
      const a = pick(st, r, policy), snap = JSON.stringify(st);
      let next;
      try { next = E.apply(st, a); } catch (e) { stats.err = `${policy} seed ${seed} 第 ${i + 1} 手 ${JSON.stringify(a)}:合法的手被丟出來:${e.message}`; break outer; }
      if (JSON.stringify(st) !== snap) { stats.err = `${policy} seed ${seed} 第 ${i + 1} 手:apply 改到傳進來的 state`; break outer; }
      const bad = judge(st, a, next, stats);
      if (bad) { stats.err = `${policy} seed ${seed} 第 ${i + 1} 手 ${JSON.stringify(a)}:${bad}`; break outer; }
      if (i % 7 === 0) { // 順手塞不合法的手:對方的飛機、超出範圍的力道
        const foePlane = next.planes.find((p) => p.side !== next.turn);
        for (const x of [{ ...a, plane: foePlane.id }, { ...a, pr: 1.5 }]) if (throws(() => E.apply(next, x))) stats.refused++; else { stats.err = `${policy} seed ${seed}:不合法的手 ${JSON.stringify(x)} 被接受`; break outer; }
      }
      actions.push(a); stats.shots++; st = next;
      if (i % 5 === 0) trail.push({ k: actions.length, json: JSON.stringify(st) });
    }
    if (!st.over) stats.unfinished++;
    stats.games++;
    stats.records.push({ policy, seed, actions, final: JSON.stringify(st), trail });
  }
  return (FUZZ = stats);
}

section("8 fuzz");
check("隨機種子、隨機的合法手:不當機,每一手之後 state 都對得上用 SPEC 重算的結果", () => {
  const f = fuzz();
  if (f.err) return f.err;
  const pop = nonEmpty(Math.min(f.kills, f.crashes, f.multi, f.refused, f.ends.wipe, f.ends.crash), "擊毀 / 一線多架 / 墜毀 / 拒絕 / 打光 / 自己摔光,至少要各發生一次");
  if (pop !== true) return `${pop}(擊毀 ${f.kills}、一線多架 ${f.multi}、墜毀 ${f.crashes}、拒絕 ${f.refused}、打光 ${f.ends.wipe}、摔光 ${f.ends.crash})`;
  return ok(f.games === 120 && f.shots > 1000, `${f.games} 局、${f.shots} 手:擊毀 ${f.kills}(一線多架 ${f.multi} 次)、墜毀 ${f.crashes}、不合法的手拒絕 ${f.refused} 次`);
});
check("每一局都在每人 30 手之內結束;三種結局都出現過(打光對方、自己摔光、耗到上限)", () => {
  if (!M1) return m1todo();
  const f = fuzz();
  if (f.err) return f.err;
  if (f.unfinished) return `${f.unfinished} / ${f.games} 局打了 60 手還沒結束`;
  const pop = nonEmpty(Math.min(f.ends.wipe, f.ends.crash, f.ends.cap), "三種結局");
  if (pop !== true) return `${pop}(打光 ${f.ends.wipe}、摔光 ${f.ends.crash}、上限 ${f.ends.cap})`;
  return ok(f.ends.wipe + f.ends.crash + f.ends.cap === f.games, `${f.games} 局:打光 ${f.ends.wipe}、摔光 ${f.ends.crash}、上限 ${f.ends.cap}`);
});

section("9 重播");
check("replay(seed, actions):fuzz 的每一局都重現同一個結局;動作過一次 JSON 也一樣;中途的每個存檔點都對得上", () => {
  if (!M1) return m1todo();
  const f = fuzz();
  if (f.err) return f.err;
  let points = 0;
  for (const rec of f.records) {
    if (JSON.stringify(E.replay(rec.seed, rec.actions)) !== rec.final) return `${rec.policy} seed ${rec.seed}:重播的結局不一樣`;
    if (JSON.stringify(E.replay(rec.seed, JSON.parse(JSON.stringify(rec.actions)))) !== rec.final) return `${rec.policy} seed ${rec.seed}:動作過一次 JSON 之後結局不一樣`;
    for (const t of rec.trail) { if (JSON.stringify(E.replay(rec.seed, rec.actions.slice(0, t.k))) !== t.json) return `${rec.policy} seed ${rec.seed}:前 ${t.k} 手的重播對不上`; points++; }
  }
  return ok(f.records.length === 120 && points > 300, `${f.records.length} 局、${points} 個中途存檔點都重現`);
});
check("重播不看 Math.random:把 Math.random 換成三種不同的亂數,重播結果都一樣;空的動作序列 = setup", () => {
  if (!M1) return m1todo();
  const rec = fuzz().records.find((x) => x.actions.length >= 10);
  if (!rec) return "母體是空的:fuzz 沒有一局超過 10 手";
  const outs = [1, 2, 3].map((s) => withSeed(s, () => JSON.stringify(E.replay(rec.seed, rec.actions))));
  const empty = JSON.stringify(E.replay(77, [])) === JSON.stringify(E.setup(77));
  return ok(outs.every((o) => o === rec.final) && empty, `${rec.actions.length} 手的一局,三種 Math.random 下結果相同=${outs.every((o) => o === rec.final)};空序列等於 setup=${empty}`);
});
check("重播遇到不合法的手:丟出來,不是跳過", () => {
  if (!M1) return m1todo();
  const rec = fuzz().records.find((x) => x.actions.length >= 4);
  if (!rec) return "母體是空的";
  const bad = rec.actions.slice(0, 3).concat([{ type: "fire", plane: rec.actions[3].plane, ang: 0, pr: 2 }], rec.actions.slice(3));
  const dup = rec.actions.slice(0, 1).concat(rec.actions.slice(0, 1)); // 同一架連出兩手:第二手不是它的回合
  const t1 = throws(() => E.replay(rec.seed, bad)), t2 = throws(() => E.replay(rec.seed, dup));
  return ok(t1 && t2, `序列中間塞一手力道 2:丟出來=${t1};同一架連出兩手(第二手不是它的回合):丟出來=${t2}`);
});

// ───────────────────────────── M2:bot ─────────────────────────────
// 數字從計畫(vault: Projects/bored_games/bored_games plan.md 的 Bots and balance)手抄:
// 瞄準角度的雜訊 簡單 ±12°、普通 ±6°、厲害 ±2.5°。平衡的三張表(先手勝率、每局出手數、等級階梯)
// 要的局數多,在 tests/sim.js(BE 的,子行程跑);這裡只放跑得快、抓崩塌的列。
const SPEC_BOT = { easy: 12, normal: 6, hard: 2.5 };
let B = null, B_ERR = null;
try { B = await import("../public/shared/dogfight/bots.js"); } catch (e) {
  // 檔案不存在 = 尚未實作;其他錯(語法錯、import 錯)= 失敗
  const missing = e && (e.code === "ERR_MODULE_NOT_FOUND" || (e instanceof TypeError && /fetch|import|load/i.test(e.message)));
  if (!missing) B_ERR = (e && e.message) || String(e);
}
const botGate = () => (B_ERR ? `bots.js 載入失敗:${B_ERR}` : !B ? "TODO: 還沒有 public/shared/dogfight/bots.js(M2)" : null);
// bot 只拿得到 view,而且是拿掉 seed / rng 的 view:下一手的誤差和弧度由 rng 決定,看得到就是偷看答案。
const blind = (st, seat) => { const v = E.view(st, seat); delete v.seed; delete v.rng; return v; };
function botGame(seed, levels) {
  let st = E.setup(seed);
  const log = [];
  while (!st.over && log.length < 2 * SPEC.MAX_SHOTS) {
    const seat = st.turn, a = B.choose(blind(st, seat), seat, levels[seat], seed * 1000 + log.length);
    const next = E.apply(st, a);
    log.push({ seat, level: levels[seat], a, lost: plane(next, a.plane).lost, kills: alive(st, 1 - seat) - alive(next, 1 - seat) });
    st = next;
  }
  return { seed, levels, st, log };
}
let BOTS = null;
function botGames() {
  if (BOTS) return BOTS;
  const t0 = Date.now(), ladder = [], mirror = [];
  try {
    for (let g = 0; g < 40; g++) ladder.push(botGame(5000 + g * 131, g % 2 === 0 ? ["hard", "easy"] : ["easy", "hard"])); // 輪流坐先手
    for (let g = 0; g < 10; g++) mirror.push(botGame(9000 + g * 131, ["normal", "normal"]));
  } catch (e) { return (BOTS = { err: `bot 對打丟出來:${(e && e.message) || e}` }); }
  return (BOTS = { ladder, mirror, all: ladder.concat(mirror), ms: Date.now() - t0 });
}
const bearingDeg = (a, me, foe) => angDiff(a.ang, Math.atan2(foe.y - me.y, foe.x - me.x)) * 180 / Math.PI;
// 一對一、敵機在正前方 150:開火是唯一合理的手,拿來量瞄準
function pointBlank(seed) {
  return place(S0(seed), { 0: [300, 600], 1: null, 2: null, 3: [300, 450], 4: null, 5: null });
}

section("10 bot");
check("LEVELS:easy / normal / hard 的瞄準雜訊是 ±12° / ±6° / ±2.5°,沒有別的等級", () => {
  const g = botGate(); if (g) return g;
  const got = Object.fromEntries(Object.entries(B.LEVELS || {}).map(([k, v]) => [k, v && v.aimNoiseDeg]));
  return eq(JSON.stringify(got), JSON.stringify(SPEC_BOT), "LEVELS[*].aimNoiseDeg");
});
check("瞄準雜訊的行為:一對一、敵機在 150 外,出手方向離敵機方位不超過該等級的雜訊,而且用到八成以上的範圍", () => {
  const g = botGate(); if (g) return g;
  const out = [];
  for (const [level, noise] of Object.entries(SPEC_BOT)) {
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const st = pointBlank(1 + (i % 5)), a = B.choose(blind(st, 0), 0, level, 40000 + i);
      const d = bearingDeg(a, plane(st, 0), plane(st, 3));
      if (d > noise + 0.01) return `${level}: bot 種子 ${40000 + i} 偏了 ${d.toFixed(2)}°(上限 ${noise}°),why=${a.why}`;
      worst = Math.max(worst, d);
    }
    if (worst < noise * 0.8) return `${level}: 200 手最多只偏 ${worst.toFixed(2)}°,不到 ±${noise}° 的八成`;
    out.push(`${level} 最多偏 ${worst.toFixed(2)}°`);
  }
  return ok(out.length === 3, out.join(";"));
});
check("近距離會打中:一對一、敵機在 150 外,hard 擊毀 ≥ 90%,easy 比 hard 差", () => {
  const g = botGate(); if (g) return g;
  const rate = (level) => { let k = 0; for (let i = 0; i < 100; i++) { const st = pointBlank(100 + i); if (!plane(E.apply(st, B.choose(blind(st, 0), 0, level, 50000 + i)), 3).alive) k++; } return k; };
  const h = rate("hard"), e = rate("easy");
  return ok(h >= 90 && e < h && e >= 30, `100 個局面:hard 擊毀 ${h},easy 擊毀 ${e}`);
});
check("不偷看:view 裡有沒有 seed / rng、rng 是多少,選的手都一樣;不改傳進來的 view", () => {
  const g = botGate(); if (g) return g;
  const bg = botGames(); if (bg.err) return bg.err;
  let n = 0;
  for (const game of bg.all.slice(0, 12)) {
    let st = E.setup(game.seed);
    for (let i = 0; i < Math.min(6, game.log.length); i++) {
      const seat = st.turn, level = game.levels[seat], bs = game.seed * 1000 + i;
      const full = E.view(st, seat), other = { ...E.view(st, seat), rng: (st.rng ^ 0x5bd1e995) | 0, seed: 1 }, none = blind(st, seat), snap = JSON.stringify(none);
      const picks = [full, other, none].map((v) => JSON.stringify(B.choose(v, seat, level, bs)));
      if (picks[0] !== picks[2] || picks[1] !== picks[2]) return `seed ${game.seed} 第 ${i + 1} 手(${level}):看得到 rng 時選 ${picks[0]},換一個 rng 選 ${picks[1]},看不到時選 ${picks[2]}`;
      if (JSON.stringify(none) !== snap) return `seed ${game.seed} 第 ${i + 1} 手:choose 改到傳進來的 view`;
      st = E.apply(st, game.log[i].a); n++;
    }
  }
  return ok(n >= 40, `${n} 個局面:三種 view 選的手一模一樣`);
});
check("決定性:同樣的(view、座位、等級、bot 種子)選同一手,不看 Math.random;換 bot 種子會換手", () => {
  const g = botGate(); if (g) return g;
  const st = E.setup(321), v = blind(st, 0);
  const picks = [1, 2, 3].map((s) => withSeed(s, () => JSON.stringify(B.choose(v, 0, "normal", 777))));
  const others = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => JSON.stringify(B.choose(v, 0, "normal", s)))).size;
  return ok(picks[0] === picks[1] && picks[1] === picks[2] && others >= 6, `三種 Math.random 下同一手=${picks[0] === picks[1] && picks[1] === picks[2]};8 個 bot 種子選出 ${others} 種手`);
});
check("bot 對打 50 局:每一手都合法、帶 why(非空字串)、每一局都結束;出手飛出紙外的比例每個等級都 < 10%", () => {
  const g = botGate(); if (g) return g;
  const bg = botGames(); if (bg.err) return bg.err;
  const by = {};
  for (const game of bg.all) {
    if (!game.st.over) return `seed ${game.seed}: ${game.log.length} 手還沒結束`;
    for (const m of game.log) {
      if (typeof m.a.why !== "string" || !m.a.why) return `seed ${game.seed}: 這一手沒有 why:${JSON.stringify(m.a)}`;
      const s = (by[m.level] ||= { shots: 0, lost: 0, kills: 0 }); s.shots++; s.kills += m.kills; if (m.lost) s.lost++;
    }
  }
  const pop = nonEmpty(Math.min(...["easy", "normal", "hard"].map((l) => (by[l] ? by[l].shots : 0))), "三個等級都要出過手"); if (pop !== true) return pop;
  const msg = Object.entries(by).map(([l, s]) => `${l} ${s.shots} 手、擊毀 ${s.kills}、出界 ${s.lost}(${(100 * s.lost / s.shots).toFixed(1)}%)`).join(";");
  return ok(Object.values(by).every((s) => s.lost / s.shots < 0.1 && s.kills > 0), `${bg.all.length} 局、${bg.ms} ms:${msg}`);
});
check("階梯的煙霧測試:hard 對 easy 40 局、輪流先手,hard 拿到 ≥ 60% 的分數(平手算半分;≥ 75% 的正式數字在 tests/sim.js)", () => {
  const g = botGate(); if (g) return g;
  const bg = botGames(); if (bg.err) return bg.err;
  let pts = 0, w = 0, d = 0, shots = 0;
  for (const game of bg.ladder) {
    const hardSeat = game.levels.indexOf("hard");
    if (game.st.winner === null) { pts += 0.5; d++; } else if (game.st.winner === hardSeat) { pts += 1; w++; }
    shots += game.log.length;
  }
  return ok(pts / bg.ladder.length >= 0.6, `hard ${w} 勝、${d} 平、${bg.ladder.length - w - d} 敗(${(100 * pts / bg.ladder.length).toFixed(0)}%),平均每局 ${(shots / bg.ladder.length).toFixed(1)} 手`);
});

// ───────────────────────────── M3:手感和文字 ─────────────────────────────
// 檔案不存在 = 尚未實作;其他錯 = 失敗。node 和瀏覽器都要能跑。
async function tryImport(rel) {
  try { return { mod: await import(rel) }; } catch (e) {
    const missing = e && (e.code === "ERR_MODULE_NOT_FOUND" || (e instanceof TypeError && /fetch|import|load/i.test(e.message)));
    return missing ? { todo: `TODO: 還沒有 ${rel.replace("../", "")}(M3)` } : { err: `${rel} 載入失敗:${(e && e.message) || e}` };
  }
}
async function readText(rel) { // rel 相對於 tests/
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    const fs = await import("node:fs");
    try { return fs.readFileSync(new URL(rel, import.meta.url), "utf8"); } catch (e) { return null; }
  }
  const r = await fetch(new URL(rel, import.meta.url)); return r.ok ? r.text() : null;
}
const gate = (x) => x.err || x.todo || null;

// 輸入手感:數字從規則筆記「輸入手感(只在前端,不進引擎)」手抄。
const SPEC_FEEL = { CHARGE_S: 1.6, SLIP: 1.45, WOB_MIN_DEG: 1.5, WOB_MAX_DEG: 14, HINT: 0.3, CANCEL_R: 18 };
const FEELM = await tryImport("../public/dogfight/feel.js");
section("11 輸入手感");
check("FEEL 常數:蓄滿 1.6 秒、撐到 1.45 倍自己滑出去、擺動 1.5° 到 14°、提示前三成、取消半徑 18", () => {
  const g = gate(FEELM); if (g) return g;
  return eq(JSON.stringify(Object.fromEntries(Object.keys(SPEC_FEEL).map((k) => [k, (FEELM.mod.FEEL || {})[k]]))), JSON.stringify(SPEC_FEEL), "FEEL");
});
check("pressure(t):0 秒 → 0,0.8 秒 → 0.5,1.6 秒之後都是 1;slipAt() = 2.32 秒", () => {
  const g = gate(FEELM); if (g) return g;
  const F = FEELM.mod, got = [0, 0.8, 1.6, 2.0, 5].map((t) => F.pressure(t));
  return ok(JSON.stringify(got) === "[0,0.5,1,1,1]" && Math.abs(F.slipAt() - 2.32) < 1e-9, `pressure = ${JSON.stringify(got)},slipAt = ${F.slipAt()}`);
});
check("wobble(t, pr):幅度 (1.5 + 12.5 × pr²)°,波形 0.6·sin(7.3t) + 0.4·sin(11.9t + 1)", () => {
  const g = gate(FEELM); if (g) return g;
  let worst = 0, peak0 = 0, peak1 = 0;
  for (let i = 0; i < 400; i++) {
    const t = i * 0.0137, pr = (i % 11) / 10;
    const want = (1.5 + 12.5 * pr * pr) * Math.PI / 180 * (0.6 * Math.sin(7.3 * t) + 0.4 * Math.sin(11.9 * t + 1));
    worst = Math.max(worst, Math.abs(FEELM.mod.wobble(t, pr) - want));
    peak0 = Math.max(peak0, Math.abs(FEELM.mod.wobble(t, 0))); peak1 = Math.max(peak1, Math.abs(FEELM.mod.wobble(t, 1)));
  }
  const deg = (r) => (r * 180 / Math.PI).toFixed(2);
  return ok(worst < 1e-9 && peak0 <= 1.5 * Math.PI / 180 + 1e-9 && peak1 > 12 * Math.PI / 180, `400 個取樣點最大誤差 ${worst.toExponential(1)};pr=0 最多擺 ${deg(peak0)}°,pr=1 最多擺 ${deg(peak1)}°`);
});
check("hintLen(pr) = 名目長度的三成(pr=0 → 30,pr=1 → 222);isCancel:拉回 18 以內算取消", () => {
  const g = gate(FEELM); if (g) return g;
  const F = FEELM.mod, h = [0, 0.5, 1].map((p) => +F.hintLen(p).toFixed(6)), c = [[0, 0], [17.9, 0], [0, -17.9], [18, 0], [13, 13]].map(([x, y]) => F.isCancel(x, y));
  return ok(JSON.stringify(h) === "[30,126,222]" && JSON.stringify(c) === "[true,true,true,false,false]", `hintLen = ${JSON.stringify(h)};isCancel = ${JSON.stringify(c)}`);
});

// 文字:玩家看得到的字只在 public/i18n/ 定義一次。key 的清單是 orchestrator 在 issue 上定的命名空間。
const I18N_KEYS = ["lang.name", "lang.other",
  "cover.title", "cover.fields", "cover.contents", "cover.game1", "cover.game2", "cover.open", "cover.notyet", "cover.foot",
  "nav.contents", "nav.rules", "nav.back", "game.title",
  "setup.vsComputer", "setup.bot.easy.name", "setup.bot.easy.desc", "setup.bot.normal.name", "setup.bot.normal.desc", "setup.bot.hard.name", "setup.bot.hard.desc",
  "setup.pair.label", "setup.pair.button", "setup.pair.hint", "setup.online.label", "setup.online.soon",
  "turn.you", "turn.bot", "turn.blue", "turn.black",
  "msg.kill", "msg.multikill", "msg.out", "msg.killButOut", "msg.cap",
  "over.youWin", "over.botWins", "over.blueWins", "over.blackWins", "over.draw", "over.summary", "over.again", "over.contents",
  "grade.aplus", "grade.a", "grade.bplus",
  "rules.title", "rules.1", "rules.2", "rules.3", "rules.4", "rules.5", "rules.6"];
const EN = await tryImport("../public/i18n/en.js"), ZH = await tryImport("../public/i18n/zh-Hant.js");
const holes = (s) => (String(s).match(/\{[a-z]+\}/g) || []).sort().join(",");
section("12 文字");
check("en 和 zh-Hant:key 一模一樣、清單上的 key 都有、沒有空字串、{name} 這類的洞兩邊一致", () => {
  const g = gate(EN) || gate(ZH); if (g) return g;
  const en = EN.mod.default || {}, zh = ZH.mod.default || {};
  const miss = I18N_KEYS.filter((k) => !(k in en) || !(k in zh));
  if (miss.length) return `缺 key:${miss.join("、")}`;
  const only = Object.keys(en).filter((k) => !(k in zh)).concat(Object.keys(zh).filter((k) => !(k in en)));
  if (only.length) return `只有一邊有:${only.join("、")}`;
  const bad = Object.keys(en).filter((k) => typeof en[k] !== "string" || typeof zh[k] !== "string" || !en[k].trim() || !zh[k].trim() || holes(en[k]) !== holes(zh[k]));
  if (bad.length) return `空的、不是字串、或兩邊的洞不一樣:${bad.join("、")}`;
  const same = Object.keys(en).filter((k) => en[k] === zh[k] && /[a-z]{3}/i.test(en[k]));
  const cjkInEn = Object.keys(en).filter((k) => k !== "lang.other" && /[\u3400-\u9fff]/.test(en[k]));
  return ok(same.length === 0 && cjkInEn.length === 0, `${Object.keys(en).length} 個 key;兩邊一字不差的 ${same.length} 個${same.length ? "(" + same.join("、") + ")" : ""};英文裡混中文的 ${cjkInEn.length} 個${cjkInEn.length ? "(" + cjkInEn.join("、") + ")" : ""}`);
});
const FE_JS = ["../public/dogfight/app.js", "../public/dogfight/feel.js", "../public/shared/paper.js", "../public/shared/i18n.js"];
const FE_SRC = await Promise.all(FE_JS.map(readText));
check("前端的程式裡沒有寫死的中文(玩家看得到的字都走 i18n;註解不算)", () => {
  if (FE_SRC[0] === null) return "TODO: 還沒有 public/dogfight/app.js(M3)";
  const hits = [];
  FE_JS.forEach((f, i) => {
    if (FE_SRC[i] === null) return;
    FE_SRC[i].replace(/\/\*[\s\S]*?\*\//g, "").split("\n").forEach((line, n) => { const code = line.replace(/\/\/.*$/, ""); if (/[\u3400-\u9fff]/.test(code)) hits.push(`${f.replace("../public/", "")}:${n + 1}`); });
  });
  const seen = FE_SRC.filter((x) => x !== null).length;
  return ok(hits.length === 0, hits.length ? `寫死的中文在:${hits.slice(0, 8).join("、")}` : `${seen} 個檔案、${FE_SRC.reduce((a, s) => a + (s ? s.split("\n").length : 0), 0)} 行,沒有寫死的中文`);
});
const FE_PAGES = await Promise.all(["../public/dogfight/index.html", "../public/index.html"].map(readText));
check("前端真的有用到 i18n:清單上的 key 至少九成出現在前端的程式或頁面裡(setup.bot. / rules. / grade. 可以是拼出來的)", () => {
  if (FE_SRC[0] === null) return "TODO: 還沒有 public/dogfight/app.js(M3)";
  const src = FE_SRC.concat(FE_PAGES).filter((x) => x !== null).join(" "), fam = ["setup.bot.", "rules.", "grade."];
  const unused = I18N_KEYS.filter((k) => !src.includes(k) && !fam.some((f) => k.startsWith(f) && src.includes(f)));
  return ok(unused.length <= I18N_KEYS.length * 0.1, `${I18N_KEYS.length} 個 key,沒被用到的 ${unused.length} 個${unused.length ? ":" + unused.join("、") : ""}`);
});

// ───────────────────────────── M3:自己畫的飛機 ─────────────────────────────
// 一張畫 = 幾條筆畫;一條筆畫 = 幾個 [x, y],座標在固定的框 [-1, 1] × [-1, 1] 裡(機頭朝 −y)。
// setup(seed, {art: [[座位 0 的三張], [座位 1 的三張]]}),每一張可以是 null(用預設的)。
const ART_TODO = () => (E.setup(1).planes.every((p) => "art" in p) ? null : "TODO: 飛機還沒有 art 欄位(M3 自己畫飛機)");
const doodle = (k) => [[[-0.5, k / 5], [0.5, k / 5], [0, -0.9]], [[0, 0.9], [0, -0.9]]]; // k / 5 剛好是小數一位,不會被四捨五入改到
const ARTS = [[doodle(1), null, doodle(2)], [doodle(3), doodle(4), null]];
section("13 自己畫的飛機");
check("RULES.ART_STROKES = 16、RULES.ART_POINTS = 400;不給 art 的時候每一架的 art 都是 null", () => {
  const g = ART_TODO(); if (g) return g;
  const got = Object.fromEntries(Object.keys(SPEC_ART).map((k) => [k, E.RULES[k]]));
  const nulls = E.setup(5).planes.filter((p) => p.art === null).length, nulls2 = E.setup(5, { art: [null, undefined] }).planes.filter((p) => p.art === null).length;
  return ok(JSON.stringify(got) === JSON.stringify(SPEC_ART) && nulls === 6 && nulls2 === 6, `RULES = ${JSON.stringify(got)};沒給 art:${nulls} / 6 是 null;給 [null, undefined]:${nulls2} / 6`);
});
check("setup(seed, {art}):座位 0 的三張給 0、1、2 號,座位 1 的給 3、4、5 號;存的是拷貝、四捨五入到小數三位;不改傳進來的東西", () => {
  const g = ART_TODO(); if (g) return g;
  const input = JSON.parse(JSON.stringify(ARTS)); input[0][0][0][0] = [-0.12345, 0.98765];
  const snap = JSON.stringify(input), st = E.setup(5, { art: input });
  const want = [input[0][0], null, input[0][2], input[1][0], input[1][1], null].map((d) => d && d.map((s) => s.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])));
  for (const p of st.planes) if (JSON.stringify(p.art) !== JSON.stringify(want[p.id])) return `飛機 ${p.id}: art = ${JSON.stringify(p.art)},應該是 ${JSON.stringify(want[p.id])}`;
  plane(st, 0).art[0][0][0] = 0.777;
  return ok(JSON.stringify(input) === snap && st.planes[0].art[0][0][1] === 0.988, `6 架都對;第一點存成 ${JSON.stringify(want[0][0][0])};輸入沒被動到=${JSON.stringify(input) === snap}`);
});
check("壞的畫一律拒絕(房間裡這是別人送來的資料):不是陣列、座標不是有限數字、超出 ±1、超過 16 條筆畫、超過 400 個點、一邊不是三張、空的筆畫", () => {
  const g = ART_TODO(); if (g) return g;
  const line = (n) => Array.from({ length: n }, (_, i) => [i / n, 0]);
  const bad = { "不是陣列": "plane", "座標是字串": [[["0", 0], [0, 1]]], "NaN": [[[NaN, 0], [0, 1]]], "超出 ±1": [[[1.001, 0], [0, 1]]], "17 條筆畫": Array.from({ length: 17 }, () => line(2)),
    "401 個點": [line(200), line(201)], "空的筆畫": [[]], "點不是一對": [[[0, 0, 0], [0, 1]]] };
  const accepted = Object.entries(bad).filter(([, d]) => !throws(() => E.setup(5, { art: [[d, null, null], null] }))).map(([k]) => k);
  if (!throws(() => E.setup(5, { art: [[doodle(1), null], null] }))) accepted.push("一邊只有兩張");
  const fine = [Array.from({ length: 16 }, () => line(25)), [[[1, -1], [-1, 1]]], [[[0, 0]]]].filter((d) => !throws(() => E.setup(5, { art: [[d, null, null], null] }))).length;
  return ok(accepted.length === 0 && fine === 3, `壞的 9 種裡被接受的:${accepted.length ? accepted.join("、") : "0 種"};剛好在上限的 3 種(16 條 × 25 點、剛好 ±1、一個點)接受了 ${fine} 種`);
});
check("只影響外觀(未知數 #4):fuzz 的每一局帶著畫重播,除了 art 以外跟沒畫的結局一模一樣;畫一路跟著飛機(含被擊毀的);view 看得到", () => {
  const g = ART_TODO(); if (g) return g;
  const f = fuzz(); if (f.err) return f.err;
  const strip = (st) => JSON.stringify({ ...st, planes: st.planes.map((p) => ({ ...p, art: 0 })) });
  let n = 0, dead = 0;
  for (const rec of f.records.slice(0, 40)) {
    const withArt = E.replay(rec.seed, rec.actions, { art: ARTS });
    if (strip(withArt) !== strip(JSON.parse(rec.final))) return `${rec.policy} seed ${rec.seed}:帶著畫的結局不一樣`;
    for (const p of withArt.planes) { const want = ARTS[p.side][p.id % 3]; if (JSON.stringify(p.art) !== JSON.stringify(want)) return `seed ${rec.seed} 飛機 ${p.id} 的畫不見了或變了`; if (!p.alive) dead++; }
    if (JSON.stringify(E.view(withArt, 1).planes.map((p) => p.art)) !== JSON.stringify(withArt.planes.map((p) => p.art))) return `seed ${rec.seed}: view 的 art 不一樣`;
    n++;
  }
  const pop = nonEmpty(dead, "被擊毀或墜毀、但還帶著畫的飛機"); if (pop !== true) return pop;
  return ok(n === 40, `${n} 局:結局相同、畫都還在(其中 ${dead} 架已經毀了)、view 看得到`);
});

// ───────────────────────────── M3:畫框(前端) ─────────────────────────────
// public/dogfight/draw.js 的純函式:把畫框裡用像素畫的筆畫,變成引擎收的 art。
//   toArt(strokesPx) → art | null      strokesPx = [[[px, py], …], …],任何像素座標、任何大小
// 「畫大畫小都一樣」(未知數 #4、草圖的畫飛機那一格):縮放進固定的框、置中、保持長寬比。
const DRAWM = await tryImport("../public/dogfight/draw.js");
const I18N_KEYS_DRAW = ["draw.title", "draw.sub", "draw.here", "draw.defaults", "draw.redo", "draw.done", "draw.blue", "draw.black"];
const bbox = (art) => { const xs = art.flat().map((p) => p[0]), ys = art.flat().map((p) => p[1]); return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]; };
function scribble(r, strokes, pts, size, ox, oy) { // 隨機亂畫:strokes 條、每條 pts 點,落在 (ox,oy) 起 size 見方裡
  return Array.from({ length: strokes }, () => { let x = r() * size, y = r() * size; return Array.from({ length: pts }, () => { x = Math.min(size, Math.max(0, x + (r() - 0.5) * size * 0.2)); y = Math.min(size, Math.max(0, y + (r() - 0.5) * size * 0.2)); return [ox + x, oy + y]; }); });
}
section("14 畫框");
check("toArt:什麼都沒畫 → null;亂畫 200 張(含 40 條筆畫、3000 個點的)每一張引擎都收", () => {
  const g = gate(DRAWM); if (g) return g;
  const T = DRAWM.mod.toArt, r = rng32(2024);
  if (T([]) !== null || T([[]]) !== null) return `空的畫應該是 null,得到 ${JSON.stringify(T([]))} / ${JSON.stringify(T([[]]))}`;
  let big = 0, maxS = 0, maxP = 0;
  for (let i = 0; i < 200; i++) {
    const heavy = i % 4 === 0, src = scribble(r, heavy ? 40 : 1 + Math.floor(r() * 10), heavy ? 75 : 2 + Math.floor(r() * 60), 20 + r() * 400, r() * 500, r() * 500);
    const art = T(src);
    if (heavy) big++;
    try { E.setup(3, { art: [[art, null, null], null] }); } catch (e) { return `第 ${i} 張(${src.length} 條、${src.flat().length} 點)引擎不收:${e.message}`; }
    if (art === null) return `第 ${i} 張有畫東西,卻變成 null`;
    maxS = Math.max(maxS, art.length); maxP = Math.max(maxP, art.flat().length);
  }
  return ok(big === 50 && maxS <= SPEC_ART.ART_STROKES && maxP <= SPEC_ART.ART_POINTS, `200 張都收(其中 ${big} 張超過上限的被化簡);化簡後最多 ${maxS} 條、${maxP} 點`);
});
check("畫大畫小都一樣:同一張畫放大 10 倍、搬到別的地方,art 一樣(差 ≤ 0.002);置中;長的那一邊撐滿 ±1、長寬比不變", () => {
  const g = gate(DRAWM); if (g) return g;
  const T = DRAWM.mod.toArt, r = rng32(7);
  let worst = 0, n = 0;
  for (let i = 0; i < 40; i++) {
    const w = 40 + r() * 200, h = 40 + r() * 200; // 刻意不是正方形
    const src = Array.from({ length: 3 }, () => Array.from({ length: 12 }, () => [100 + r() * w, 50 + r() * h]));
    src[0][0] = [100, 50]; src[0][1] = [100 + w, 50 + h]; // 釘住外框,長寬比才算得出來
    const a = T(src), b = T(src.map((s) => s.map(([x, y]) => [x * 10 - 3000, y * 10 + 777])));
    if (JSON.stringify(a.map((s) => s.length)) !== JSON.stringify(b.map((s) => s.length))) return `第 ${i} 張:放大後筆畫的點數不一樣`;
    a.forEach((s, si) => s.forEach((p, pi) => { worst = Math.max(worst, Math.abs(p[0] - b[si][pi][0]), Math.abs(p[1] - b[si][pi][1])); }));
    const [x0, x1, y0, y1] = bbox(a), span = Math.max(x1 - x0, y1 - y0);
    if (Math.abs(x0 + x1) > 0.004 || Math.abs(y0 + y1) > 0.004) return `第 ${i} 張沒有置中:x ${x0} 到 ${x1},y ${y0} 到 ${y1}`;
    if (Math.abs(span - 2) > 0.004) return `第 ${i} 張長邊是 ${span.toFixed(3)},應該撐滿 2`;
    if (Math.abs((x1 - x0) / (y1 - y0) - w / h) > 0.02 * (w / h)) return `第 ${i} 張長寬比變了:${((x1 - x0) / (y1 - y0)).toFixed(3)},原本 ${(w / h).toFixed(3)}`;
    n++;
  }
  return ok(n === 40 && worst <= 0.002, `${n} 張:放大 10 倍再搬家,座標最多差 ${worst.toFixed(4)}`);
});
check("只點一下(一個點、或所有點都在同一個位置):不會除以零,引擎收", () => {
  const g = gate(DRAWM); if (g) return g;
  const outs = [[[[50, 50]]], [[[50, 50], [50, 50], [50, 50]]]].map((src) => DRAWM.mod.toArt(src));
  for (const art of outs) { if (art === null) continue; if (art.flat(2).some((v) => !Number.isFinite(v))) return `出現不是數字的座標:${JSON.stringify(art)}`; E.setup(3, { art: [[art, null, null], null] }); }
  return ok(true, `一個點 → ${JSON.stringify(outs[0])};同一個位置三個點 → ${JSON.stringify(outs[1])}`);
});
check("畫框的字:draw.* 八個 key 兩種語言都有、不是空的", () => {
  const g = gate(DRAWM) || gate(EN) || gate(ZH); if (g) return g;
  const en = EN.mod.default, zh = ZH.mod.default, miss = I18N_KEYS_DRAW.filter((k) => !(typeof en[k] === "string" && en[k].trim()) || !(typeof zh[k] === "string" && zh[k].trim()));
  return ok(miss.length === 0, miss.length ? `缺:${miss.join("、")}` : `${I18N_KEYS_DRAW.length} 個 key 都在`);
});

// ───────────────────────────── 先手隨機、view 藏亂數 ─────────────────────────────
// owner 裁決(#4):「randomly who is the first.」;owner 裁決(#2):view 藏 seed 和 rng。
const FIRST_TODO = () => (E.setup(1, { first: 1 }).turn === 1 ? null : "TODO: setup 還不認得 first(#10)");
section("15 先手隨機");
check("不指定:誰先手由種子決定,400 個種子裡兩個座位各佔 40% 到 60%;同一個種子每次一樣;先手的座位有 3 種手、另一邊沒有", () => {
  const g = FIRST_TODO(); if (g) return g;
  let n1 = 0;
  for (let i = 0; i < 400; i++) {
    const seed = i * 2654435 + 11, st = E.setup(seed);
    if (st.turn !== 0 && st.turn !== 1) return `seed ${seed}: turn=${st.turn}`;
    if (E.setup(seed).turn !== st.turn) return `seed ${seed}: 兩次 setup 的先手不一樣`;
    if (E.legal(st, st.turn).length !== 3 || E.legal(st, 1 - st.turn).length !== 0) return `seed ${seed}: 先手 ${st.turn} 有 ${E.legal(st, st.turn).length} 種手,另一邊 ${E.legal(st, 1 - st.turn).length} 種`;
    n1 += st.turn;
  }
  return ok(n1 >= 160 && n1 <= 240, `400 個種子:座位 0 先手 ${400 - n1} 局,座位 1 先手 ${n1} 局`);
});
check("硬幣不是種子的低位元:只用偶數、只用奇數、只用 1024 的倍數、連續的種子,四族各 400 個,每一族座位 1 先手都在 40% 到 60%", () => {
  const g = FIRST_TODO(); if (g) return g;
  const fam = { "偶數": (i) => i * 2 + 1000, "奇數": (i) => i * 2 + 1001, "1024 的倍數": (i) => (i + 7) * 1024, "連續": (i) => 50000 + i };
  const out = [];
  for (const [name, f] of Object.entries(fam)) {
    let n1 = 0; for (let i = 0; i < 400; i++) n1 += E.setup(f(i)).turn;
    if (n1 < 160 || n1 > 240) return `${name}的種子:座位 1 先手 ${n1} / 400,硬幣跟著種子的樣式走`;
    out.push(`${name} ${n1}`);
  }
  return ok(out.length === 4, `座位 1 先手 / 400:${out.join("、")}`);
});
check("指定 first: 0 或 1 就照指定的;除了 turn 以外整個 state(含 rng)跟不指定的一模一樣;first 給別的東西就拒絕", () => {
  const g = FIRST_TODO(); if (g) return g;
  const noTurn = (st) => JSON.stringify({ ...st, turn: 0 });
  for (const seed of SEEDS) for (const first of [0, 1]) {
    const st = E.setup(seed, { first });
    if (st.turn !== first) return `seed ${seed} first=${first}: turn=${st.turn}`;
    if (noTurn(st) !== noTurn(E.setup(seed))) return `seed ${seed} first=${first}: 指定先手改到了 turn 以外的東西(起始位置或 rng)`;
  }
  const bad = [2, -1, "0", 0.5, NaN, true].filter((f) => !throws(() => E.setup(1, { first: f })));
  return ok(bad.length === 0, bad.length ? `被接受的壞 first:${JSON.stringify(bad)}` : `${SEEDS.length} 個種子 × 兩種指定都對;6 種壞的 first 都被拒絕;first: undefined / null 當成不指定=${E.setup(3, { first: undefined }).turn === E.setup(3).turn && E.setup(3, { first: null }).turn === E.setup(3).turn}`);
});
check("座位 1 先手的一局:它先出手、換座位 0;打滿也是各 30 手才結束(shots [30,30])", () => {
  const g = FIRST_TODO(); if (g) return g;
  let st = place(E.setup(4, { first: 1 }), { 1: [300, 700], 4: [300, 200] });
  if (throws(() => fire(st, 4, 0, 0)) || !throws(() => fire(st, 1, 0, 0))) return "座位 1 先手時,它不能出手、或座位 0 反而可以";
  st = shuffle(st, 59);
  if (st.over || st.turn !== 0 || JSON.stringify(st.shots) !== "[29,30]") return `59 手之後 over=${st.over} turn=${st.turn} shots=${JSON.stringify(st.shots)}`;
  st = shuffle(st, 1);
  return ok(st.over && st.winner === null && JSON.stringify(st.shots) === "[30,30]", `59 手 shots=[29,30] 還沒結束;60 手 shots=${JSON.stringify(st.shots)} over=${st.over} winner=${st.winner}`);
});
check("fuzz 和重播涵蓋兩種先手:120 局裡兩個座位都當過先手", () => {
  const g = FIRST_TODO(); if (g) return g;
  const f = fuzz(); if (f.err) return f.err;
  const firsts = f.records.map((rec) => plane(E.setup(rec.seed), rec.actions[0].plane).side), n1 = firsts.filter((x) => x === 1).length;
  if (f.records.some((rec, i) => E.setup(rec.seed).turn !== firsts[i])) return "第一手不是先手的那一邊出的";
  return ok(n1 >= 30 && n1 <= 90, `座位 0 先手 ${120 - n1} 局,座位 1 先手 ${n1} 局`);
});
section("16 view 藏亂數");
check("view(state, seat) 沒有 seed 和 rng(兩個座位、開局 / 打到一半 / 結束都一樣);其他欄位一個不少;state 自己還留著", () => {
  const g = FIRST_TODO(); if (g) return g;
  const states = [E.setup(11), shuffle(capStart(11), 7), fire(place(S0(9), { 0: null, 1: null }), 2, Math.PI / 2, 1)];
  let n = 0;
  for (const st of states) for (const seat of [0, 1, undefined]) {
    const v = E.view(st, seat), leaked = ["seed", "rng"].filter((k) => k in v);
    if (leaked.length) return `seat ${seat}: view 裡還有 ${leaked.join("、")}`;
    const want = Object.keys(st).filter((k) => k !== "seed" && k !== "rng").sort().join(","), got = Object.keys(v).sort().join(",");
    if (want !== got) return `seat ${seat}: view 的欄位是 ${got},應該是 ${want}`;
    if (!("seed" in st) || !("rng" in st)) return "state 自己的 seed / rng 不見了";
    n++;
  }
  return ok(n === 9, `${n} 個 view 都沒有 seed / rng,其他 ${Object.keys(states[0]).length - 2} 個欄位都在`);
});

// ───────────────────────────── M4:房間的核心 ─────────────────────────────
// src/room-core.js:純函式的房間狀態機(不碰 WebSocket、不碰時鐘、不碰亂數——都從外面給)。
//   create(code) → room
//   step(room, ev, now, rand) → { room, out: [{ to: token, msg }] }     不改傳進來的 room
//   ev: {type:"hello", token, art} | {type:"fire", token, plane, ang, pr} | {type:"bot", token}
//     | {type:"again", token} | {type:"drop", token} | {type:"tick"}
// 數字:回合時鐘 30 秒、斷線 20 秒後電腦接手(計畫的 Architecture);其餘是 orchestrator 裁決(#12)。
const SPEC_ROOM = { TURN_MS: 30000, OFFLINE_MS: 20000, BOT_DELAY_MS: 1200, IDLE_MS: 600000, BOT_LEVEL: "normal", MAX_MSG: 16384 };
const RM = await tryImport("../src/room-core.js");
function roomDriver() {
  const R = RM.mod; let k = 12345;
  const d = { room: R.create("KQRT"), err: null, now: 1000000,
    rand: () => (k = (Math.imul(k, 1103515245) + 12345) >>> 0),
    send(ev, now) {
      if (now !== undefined) d.now = now;
      const snap = JSON.stringify(d.room), r = R.step(d.room, ev, d.now, d.rand);
      if (JSON.stringify(d.room) !== snap && !d.err) d.err = `step(${ev.type}) 改到了傳進來的 room`;
      d.room = r.room; return r.out;
    } };
  return d;
}
const toOf = (out, token, t = "state") => out.filter((o) => o.to === token && o.msg.t === t).map((o) => o.msg);
section("17 房間的核心");
check("ROOM 常數:回合 30 秒、斷線 20 秒電腦接手、電腦想 1.2 秒、閒置 10 分鐘、頂替的是 normal、訊息上限 16 KB", () => {
  const g = gate(RM); if (g) return g;
  return eq(JSON.stringify(Object.fromEntries(Object.keys(SPEC_ROOM).map((key) => [key, (RM.mod.ROOM || {})[key]]))), JSON.stringify(SPEC_ROOM), "ROOM");
});
check("進房:第一個人是座位 0、等人;第二個人進來就開打,兩邊各收到自己的 view(沒有 seed / rng)、帶著自己的畫、30 秒的期限;第三個人被拒絕、房間不變", () => {
  const g = gate(RM); if (g) return g;
  const d = roomDriver();
  const a = toOf(d.send({ type: "hello", token: "token-aaaa", art: null }), "token-aaaa")[0];
  if (!a || a.seat !== 0 || a.phase !== "waiting" || a.view !== null || a.code !== "KQRT" || JSON.stringify(a.seats.map((s) => s.kind)) !== JSON.stringify(["human", "empty"])) return `第一個人收到 ${JSON.stringify(a)}`;
  const out = d.send({ type: "hello", token: "token-bbbb", art: [doodle(1), null, null] }, d.now + 5000);
  const ma = toOf(out, "token-aaaa")[0], mb = toOf(out, "token-bbbb")[0];
  if (!ma || !mb || ma.seat !== 0 || mb.seat !== 1 || ma.phase !== "playing" || mb.phase !== "playing") return `第二個人進來之後:a=${JSON.stringify(ma && [ma.seat, ma.phase])} b=${JSON.stringify(mb && [mb.seat, mb.phase])}`;
  for (const m of [ma, mb]) { if (!m.view || "rng" in m.view || "seed" in m.view) return "view 是空的、或裡面有 seed / rng"; if (m.deadline !== d.now + SPEC_ROOM.TURN_MS) return `期限 ${m.deadline},應該是 ${d.now + SPEC_ROOM.TURN_MS}`; }
  if (JSON.stringify(ma.view.planes[3].art) !== JSON.stringify(doodle(1)) || ma.view.planes[0].art !== null) return "畫沒有跟著座位走";
  const snap = JSON.stringify(d.room), oc = d.send({ type: "hello", token: "token-cccc", art: null });
  const full = toOf(oc, "token-cccc", "error")[0];
  return ok(!d.err && full && full.code === "full" && oc.length === 1 && JSON.stringify(d.room) === snap, `第三個人:${JSON.stringify(full)};房間沒變=${JSON.stringify(d.room) === snap}${d.err ? ";" + d.err : ""}`);
});
check("出手:沒輪到的人、不合法的手都被拒絕而且房間不變;合法的手兩邊都收到新的 view、last 記下誰出了什麼、期限重算", () => {
  const g = gate(RM); if (g) return g;
  const d = roomDriver(); d.send({ type: "hello", token: "token-aaaa", art: null });
  const st = toOf(d.send({ type: "hello", token: "token-bbbb", art: null }), "token-aaaa")[0], turn = st.view.turn, tok = ["token-aaaa", "token-bbbb"];
  const mine = st.view.planes.find((p) => p.side === turn && p.alive).id, theirs = st.view.planes.find((p) => p.side !== turn && p.alive).id;
  const snap = JSON.stringify(d.room);
  const e1 = toOf(d.send({ type: "fire", token: tok[1 - turn], plane: theirs, ang: 0, pr: 0 }), tok[1 - turn], "error")[0];
  const e2 = toOf(d.send({ type: "fire", token: tok[turn], plane: mine, ang: 0, pr: 2 }), tok[turn], "error")[0];
  if (!e1 || e1.code !== "not_your_turn" || !e2 || e2.code !== "bad_move" || JSON.stringify(d.room) !== snap) return `沒輪到:${JSON.stringify(e1)};壞的手:${JSON.stringify(e2)};房間沒變=${JSON.stringify(d.room) === snap}`;
  const out = d.send({ type: "fire", token: tok[turn], plane: mine, ang: 0, pr: 0 }, d.now + 4000), ma = toOf(out, "token-aaaa")[0], mb = toOf(out, "token-bbbb")[0];
  if (!ma || !mb) return "合法的手之後沒有兩邊都收到 state";
  const good = ma.view.turn === 1 - turn && ma.view.shots[turn] === 1 && ma.last && ma.last.by === turn && ma.last.action.plane === mine && !ma.last.auto && ma.deadline === d.now + SPEC_ROOM.TURN_MS && JSON.stringify(ma.view) === JSON.stringify(mb.view);
  return ok(good && !d.err, `turn ${turn} → ${ma.view.turn},shots=${JSON.stringify(ma.view.shots)},last=${JSON.stringify(ma.last)},期限 +${ma.deadline - d.now} ms${d.err ? ";" + d.err : ""}`);
});
check("回合時鐘:期限前一毫秒 tick 什麼都不發生;到期限,電腦替那個座位出一手(last.auto),座位還是真人的", () => {
  const g = gate(RM); if (g) return g;
  const d = roomDriver(); d.send({ type: "hello", token: "token-aaaa", art: null });
  const st = toOf(d.send({ type: "hello", token: "token-bbbb", art: null }), "token-aaaa")[0], turn = st.view.turn;
  const snap = JSON.stringify(d.room), early = d.send({ type: "tick" }, st.deadline - 1);
  if (early.length || JSON.stringify(d.room) !== snap) return `期限前:送出 ${early.length} 則訊息,房間變了=${JSON.stringify(d.room) !== snap}`;
  if (d.room.wake !== st.deadline) return `room.wake=${d.room.wake},應該是期限 ${st.deadline}`;
  const m = toOf(d.send({ type: "tick" }, st.deadline), "token-aaaa")[0];
  return ok(m && m.view.shots[turn] === 1 && m.last.by === turn && m.last.auto === true && m.seats[turn].kind === "human" && m.view.turn === 1 - turn && !d.err,
    m ? `逾時的座位 ${turn}:shots=${JSON.stringify(m.view.shots)} last.auto=${m.last.auto} kind=${m.seats[turn].kind}` : "到期限沒有送出 state");
});
check("斷線:對方馬上看到 offline;19.999 秒還是真人的座位,20 秒電腦接手;同一個 token 回來就拿回座位、收到現況", () => {
  const g = gate(RM); if (g) return g;
  const d = roomDriver(); d.send({ type: "hello", token: "token-aaaa", art: null }); d.send({ type: "hello", token: "token-bbbb", art: null });
  const t0 = d.now, m0 = toOf(d.send({ type: "drop", token: "token-bbbb" }), "token-aaaa")[0];
  if (!m0 || m0.seats[1].online !== false || m0.seats[1].kind !== "human") return `斷線當下 a 收到 ${JSON.stringify(m0 && m0.seats)}`;
  const kindAt = (now) => { d.send({ type: "tick" }, now); return d.room.seats[1].kind; };
  const k1 = kindAt(t0 + SPEC_ROOM.OFFLINE_MS - 1), k2 = kindAt(t0 + SPEC_ROOM.OFFLINE_MS);
  const back = d.send({ type: "hello", token: "token-bbbb", art: null }, t0 + SPEC_ROOM.OFFLINE_MS + 3000), mb = toOf(back, "token-bbbb")[0];
  return ok(k1 === "human" && k2 === "bot" && mb && mb.seat === 1 && mb.seats[1].kind === "human" && mb.seats[1].online === true && mb.phase === "playing" && !d.err,
    `19.999 秒:${k1};20 秒:${k2};回來之後:${JSON.stringify(mb && mb.seats[1])}${d.err ? ";" + d.err : ""}`);
});
check("等不到人:{type:\"bot\"} 讓 normal 的電腦坐座位 1、馬上開打;電腦輪到時 1.2 秒後自己出手;已經開打了再叫電腦會被拒絕", () => {
  const g = gate(RM); if (g) return g;
  for (let tries = 0; tries < 8; tries++) {
    const d = roomDriver(); for (let i = 0; i < tries; i++) d.rand();
    d.send({ type: "hello", token: "token-aaaa", art: null });
    const m = toOf(d.send({ type: "bot", token: "token-aaaa" }), "token-aaaa")[0];
    if (!m || m.phase !== "playing" || m.seats[1].kind !== "bot") return `叫電腦之後:${JSON.stringify(m && [m.phase, m.seats])}`;
    if (m.view.turn !== 1) continue; // 要一局電腦先手的
    if (d.room.wake !== d.now + SPEC_ROOM.BOT_DELAY_MS) return `電腦先手時 room.wake 在 ${d.room.wake - d.now} ms 之後,應該是 ${SPEC_ROOM.BOT_DELAY_MS}`;
    const again = toOf(d.send({ type: "bot", token: "token-aaaa" }), "token-aaaa", "error")[0];
    if (!again) return "已經開打了再叫電腦,沒有被拒絕";
    if (d.send({ type: "tick" }, d.now + SPEC_ROOM.BOT_DELAY_MS - 1).length) return "電腦還沒想完就出手了";
    const mv = toOf(d.send({ type: "tick" }, d.now + 1), "token-aaaa")[0];
    return ok(mv && mv.view.shots[1] === 1 && mv.last.by === 1 && mv.view.turn === 0 && !d.err, `第 ${tries + 1} 個房間電腦先手:1.2 秒後出手,shots=${JSON.stringify(mv && mv.view.shots)}`);
  }
  return "母體是空的:8 個房間沒有一局是電腦先手";
});
check("沒有人動,房間也會自己走到結束:只在 room.wake 的時間點 tick,每一次都有進展;結束時 replay(log) 跟房間的 state 一樣;兩個人都說再來一張就開新的一局(畫留著、種子換了)", () => {
  const g = gate(RM); if (g) return g;
  const d = roomDriver(); d.send({ type: "hello", token: "token-aaaa", art: [null, doodle(2), null] }); d.send({ type: "hello", token: "token-bbbb", art: null });
  let n = 0, autos = 0;
  while (d.room.phase !== "over" && n < 200) {
    if (typeof d.room.wake !== "number" || d.room.wake <= d.now) return `第 ${n} 次:room.wake=${d.room.wake},現在 ${d.now}——房間不會自己醒來`;
    const before = d.room.log.actions.length, out = d.send({ type: "tick" }, d.room.wake);
    if (d.room.log.actions.length === before && d.room.phase !== "over") return `第 ${n} 次在 room.wake tick 沒有任何進展`;
    if (out.some((o) => o.msg.t === "state" && o.msg.last && o.msg.last.auto)) autos++;
    n++;
  }
  if (d.room.phase !== "over") return `${n} 次 tick 之後還沒結束`;
  const same = JSON.stringify(E.replay(d.room.log.seed, d.room.log.actions, { art: d.room.log.art })) === JSON.stringify(d.room.state);
  const winner = d.room.state.winner, seed0 = d.room.log.seed, one = toOf(d.send({ type: "again", token: "token-aaaa" }), "token-bbbb")[0];
  if (!one || one.phase !== "over" || JSON.stringify(one.again) !== "[true,false]") return `只有一個人說再來:${JSON.stringify(one && [one.phase, one.again])}`;
  const two = toOf(d.send({ type: "again", token: "token-bbbb" }), "token-aaaa")[0];
  return ok(same && two && two.phase === "playing" && d.room.log.seed !== seed0 && d.room.log.actions.length === 0 && JSON.stringify(two.view.planes[1].art) === JSON.stringify(doodle(2)) && !d.err,
    `${n} 次 tick(${autos} 次逾時代打)走到結束,winner=${winner};replay 相同=${same};再來一張:phase=${two && two.phase} 新種子=${d.room.log.seed !== seed0}${d.err ? ";" + d.err : ""}`);
});
check("壞的 hello:畫不合格 → bad_art、沒有座位;token 不是 8 到 64 個字元的字串 → bad_hello;同一串事件跑兩次,房間一模一樣(決定性,不看 Math.random)", () => {
  const g = gate(RM); if (g) return g;
  const d = roomDriver(), snap = JSON.stringify(d.room);
  const e1 = toOf(d.send({ type: "hello", token: "token-aaaa", art: [[[[2, 0], [0, 1]]], null, null] }), "token-aaaa", "error")[0];
  const bad = ["", "short", "x".repeat(65), 42, null].filter((token) => { const o = d.send({ type: "hello", token, art: null }); return o.length === 1 && o[0].msg.t === "error" && o[0].msg.code === "bad_hello"; }).length;
  if (!e1 || e1.code !== "bad_art" || bad !== 5 || JSON.stringify(d.room) !== snap) return `壞的畫:${JSON.stringify(e1)};壞的 token 被拒絕 ${bad} / 5;房間沒變=${JSON.stringify(d.room) === snap}`;
  const run = () => { const x = roomDriver(); x.send({ type: "hello", token: "token-aaaa", art: null }); x.send({ type: "bot", token: "token-aaaa" }); for (let i = 0; i < 12 && x.room.phase !== "over"; i++) x.send({ type: "tick" }, x.room.wake); return JSON.stringify(x.room); };
  const a = withSeed(1, run), b = withSeed(2, run);
  return ok(a === b && !d.err, `壞的畫 → bad_art;5 種壞 token 都 bad_hello;兩次跑出來的房間相同=${a === b}`);
});
check("兩個人都走了:電腦把這一局打完,之後閒置 10 分鐘,房間 phase 變成 dead(DO 就可以把自己刪掉)", () => {
  const g = gate(RM); if (g) return g;
  const d = roomDriver(); d.send({ type: "hello", token: "token-aaaa", art: null }); d.send({ type: "hello", token: "token-bbbb", art: null });
  d.send({ type: "drop", token: "token-aaaa" }); const left = d.now; d.send({ type: "drop", token: "token-bbbb" });
  let n = 0;
  while (d.room.phase !== "dead" && n < 300) { if (typeof d.room.wake !== "number" || d.room.wake <= d.now) return `第 ${n} 次:room.wake=${d.room.wake}`; d.send({ type: "tick" }, d.room.wake); n++; }
  return ok(d.room.phase === "dead" && d.now - left >= SPEC_ROOM.IDLE_MS && !d.err, `${n} 次 tick 之後 phase=${d.room.phase},離最後一個人走掉 ${((d.now - left) / 60000).toFixed(1)} 分鐘`);
});

// 連線對戰的字(M4)。key 的清單是 orchestrator 定的命名空間(#13);兩個檔案都還沒有任何一個 = 尚未實作。
const I18N_KEYS_ROOM = ["setup.online.open", "setup.online.code", "setup.online.join", "room.label", "room.tell", "room.copy", "room.copied", "room.waiting", "room.sitin", "room.badcode", "room.full",
  "net.connecting", "net.lost", "net.oppOffline", "net.oppBot", "net.oppBack", "turn.opp", "turn.clock", "msg.autoYou", "msg.autoOpp", "over.oppWins", "again.waiting", "again.oppWants"];
const ROOM_HOLES = { "room.waiting": "{time}", "room.sitin": "{name}", "net.oppOffline": "{sec}", "turn.clock": "{sec}" };
section("18 連線的字");
check("連線對戰的 23 個 key 兩種語言都有、不是空的;有洞的四個(等人的時間、頂替的名字、接手倒數、回合倒數)洞的名字對", () => {
  const g = gate(EN) || gate(ZH); if (g) return g;
  const en = EN.mod.default, zh = ZH.mod.default;
  if (!I18N_KEYS_ROOM.some((k) => k in en || k in zh)) return "TODO: 還沒有連線對戰的字(#13)";
  const miss = I18N_KEYS_ROOM.filter((k) => !(typeof en[k] === "string" && en[k].trim()) || !(typeof zh[k] === "string" && zh[k].trim()));
  if (miss.length) return `缺:${miss.join("、")}`;
  const badHole = I18N_KEYS_ROOM.filter((k) => holes(en[k]) !== (ROOM_HOLES[k] || "") || holes(zh[k]) !== (ROOM_HOLES[k] || ""));
  return ok(badHole.length === 0, badHole.length ? `洞不對:${badHole.map((k) => `${k}(en ${holes(en[k]) || "無"} / zh ${holes(zh[k]) || "無"},應該是 ${ROOM_HOLES[k] || "無"})`).join("、")}` : `${I18N_KEYS_ROOM.length} 個 key 都在,洞都對`);
});
section("17 房間的核心(追加)");
check("state 訊息帶著伺服器的 now(客戶端的時鐘不準:倒數要用 deadline − now 算,不是 deadline − 自己的時鐘)", () => {
  const g = gate(RM); if (g) return g;
  const d = roomDriver(); const a = toOf(d.send({ type: "hello", token: "token-aaaa", art: null }), "token-aaaa")[0];
  if (!("now" in a)) return "TODO: state 訊息還沒有 now(#12 的追加)";
  const at2 = d.now + 7777, out = d.send({ type: "hello", token: "token-bbbb", art: null }, at2), b = toOf(out, "token-bbbb")[0]; // at2 先存起來:下面的 tick 會改 d.now
  const tick = toOf(d.send({ type: "tick" }, b.deadline), "token-aaaa")[0];
  return ok(a.now === 1000000 && b.now === at2 && b.deadline - b.now === SPEC_ROOM.TURN_MS && tick && tick.now === b.deadline, `進房 now=${a.now};開打 now=${b.now}、deadline − now=${b.deadline - b.now};逾時那一則 now=${tick && tick.now}`);
});

// ───────────────────────────── M4:連線的前端(純函式的部分) ─────────────────────────────
// public/dogfight/net.js:房間碼、token、倒數。畫面和 WebSocket 的接線用眼睛和兩個分頁驗。
const NETM = await tryImport("../public/dogfight/net.js");
section("19 連線的前端");
check("房間碼:genCode 產生的都是四個大寫字母、沒有 I 和 O、2000 個裡至少 1500 種;normCode 把小寫和空白整理好,不合格的回 null", () => {
  const g = gate(NETM); if (g) return g;
  const N = NETM.mod, r = rng32(99), seen = new Set();
  for (let i = 0; i < 2000; i++) { const c = N.genCode(r); if (!/^[A-HJ-NP-Z]{4}$/.test(c)) return `genCode 產生了 ${JSON.stringify(c)}`; seen.add(c); }
  const norm = [" kqrt ", "KqRt", "k q r t", "KQRT"].map((x) => N.normCode(x)), bad = ["KQR", "KQRTS", "KIRT", "KORT", "K1RT", "", null, 42].filter((x) => N.normCode(x) !== null);
  return ok(seen.size >= 1500 && norm.every((x) => x === "KQRT") && bad.length === 0, `${seen.size} / 2000 種;整理後 ${JSON.stringify(norm)};不合格卻被接受的:${JSON.stringify(bad)}`);
});
check("token:newToken 是 8 到 64 個字元的字串,100 個都不一樣", () => {
  const g = gate(NETM); if (g) return g;
  const r = rng32(5), ts = Array.from({ length: 100 }, () => NETM.mod.newToken(r));
  const badOnes = ts.filter((t) => typeof t !== "string" || t.length < 8 || t.length > 64);
  return ok(badOnes.length === 0 && new Set(ts).size === 100, `100 個 token,長度 ${Math.min(...ts.map((t) => t.length))} 到 ${Math.max(...ts.map((t) => t.length))},不重複 ${new Set(ts).size} 個`);
});
check("倒數只用伺服器的 now:remainingMs(msg, 收到時的本機時間, 現在的本機時間) = deadline − now −(過了多久),不會是負的;本機時鐘快 3 秒也一樣;沒有期限回 null", () => {
  const g = gate(NETM); if (g) return g;
  const R = NETM.mod.remainingMs, msg = { now: 5000000, deadline: 5030000 };
  const skew = 3311, got = [R(msg, 9000000 + skew, 9000000 + skew), R(msg, 9000000 + skew, 9012000 + skew), R(msg, 9000000 + skew, 9031000 + skew), R({ now: 1, deadline: null }, 5, 6)];
  return ok(JSON.stringify(got) === "[30000,18000,0,null]", `剛收到 ${got[0]}、過了 12 秒 ${got[1]}、過了 31 秒 ${got[2]}、沒有期限 ${got[3]}`);
});
check("前端顯示「幾秒後電腦接手」用的 OFFLINE_MS 跟伺服器的是同一個數字(同一個事實有兩份:伺服器一改,這裡要紅)", () => {
  const g = gate(NETM) || gate(RM); if (g) return g;
  return ok(NETM.mod.OFFLINE_MS === SPEC_ROOM.OFFLINE_MS && RM.mod.ROOM.OFFLINE_MS === NETM.mod.OFFLINE_MS, `net.js ${NETM.mod.OFFLINE_MS},room-core ${RM.mod.ROOM.OFFLINE_MS},規格 ${SPEC_ROOM.OFFLINE_MS}`);
});

// 重畫按鈕(owner 回報,#16):「重畫沒有用」——原本只清「這一次碰過的那一框」,沒碰過任何框(框裡是上次存的畫)就什麼都不做。
section("20 重畫");
check("redoTarget(目前的框, 哪幾框有畫):目前的框有畫就清它;目前的框是空的、或還沒碰過任何框(-1),就清第一個有畫的;全部都空才是 -1", () => {
  const g = gate(DRAWM); if (g) return g;
  const f = DRAWM.mod.redoTarget; if (typeof f !== "function") return "TODO: draw.js 還沒有 redoTarget(#16)";
  const cases = [[[-1, [true, true, false]], 0], [[-1, [false, true, true]], 1], [[2, [true, true, true]], 2], [[2, [true, false, false]], 0], [[1, [false, false, true]], 2], [[-1, [false, false, false]], -1], [[0, [false, false, false]], -1], [[1, [true, true, true]], 1]];
  const bad = cases.filter(([args, want]) => f(args[0], args[1]) !== want).map(([args, want]) => `redoTarget(${args[0]}, ${JSON.stringify(args[1])}) = ${f(args[0], args[1])},應該是 ${want}`);
  return ok(bad.length === 0, bad.length ? bad.join(";") : `${cases.length} 種情況都對(沒碰過任何框、框裡有上次的畫 → 清第一個有畫的)`);
});

// ───────────────────────────── M5:上架 ─────────────────────────────
// owner 2026-09-25:「M5 go」。優先序第一條:拿掉 noindex,public/ 底下每一頁都要,一頁都不能漏。
// 頁面清單從計畫抄(封面、紙上空戰、規則頁),不從產品讀;node 另外列目錄,多出來的頁也要進這張表。
const SPEC_PAGES = ["index.html", "dogfight/index.html", "dogfight/rules.html"];
const NOINDEX = /<meta\b[^>]*\bname\s*=\s*["']?robots["']?[^>]*>/gi;
const isNode = typeof process !== "undefined" && process.versions && process.versions.node;
async function listHtml() { // public/ 底下所有 .html(相對路徑,/ 分隔);瀏覽器列不了目錄 → null
  if (!isNode) return null;
  const fs = await import("node:fs");
  return fs.readdirSync(new URL("../public/", import.meta.url), { recursive: true })
    .map((p) => String(p).split("\\").join("/")).filter((p) => p.endsWith(".html")).sort();
}
const HTML_ON_DISK = await listHtml();
const PAGES = await Promise.all(SPEC_PAGES.map(async (p) => ({ p, html: await readText("../public/" + p) })));
const SRC_TXT = await Promise.all(["../src/index.js", "../src/room.js", "../src/room-core.js"].map(readText));
section("21 上架:noindex");
check("public/ 底下的 .html 就是計畫裡的那 3 頁(多一頁沒列進來,它就逃過下面那一列)", () => {
  if (!HTML_ON_DISK) return ok(true, "瀏覽器列不了目錄:這一列只在 node 有查(node tests/print.js)");
  const extra = HTML_ON_DISK.filter((p) => !SPEC_PAGES.includes(p)), gone = SPEC_PAGES.filter((p) => !HTML_ON_DISK.includes(p));
  return ok(extra.length === 0 && gone.length === 0, extra.length || gone.length ? `多出:${extra.join("、") || "無"};不見了:${gone.join("、") || "無"}` : `${HTML_ON_DISK.length} 頁:${HTML_ON_DISK.join("、")}`);
});
check("每一頁都沒有 robots noindex(全部都還有 = 尚未實作;有的拿掉有的沒拿掉 = 失敗,一頁都不能漏)", () => {
  const n = nonEmpty(PAGES.filter((x) => x.html).length, "讀得到的頁面"); if (n !== true) return n;
  const unread = PAGES.filter((x) => !x.html).map((x) => x.p); if (unread.length) return `讀不到:${unread.join("、")}`;
  const still = PAGES.filter((x) => (x.html.match(NOINDEX) || []).some((m) => /noindex/i.test(m))).map((x) => x.p);
  if (still.length === PAGES.length) return `TODO: ${PAGES.length} 頁都還是 noindex(M5)`;
  return ok(still.length === 0, still.length ? `還是 noindex:${still.join("、")}` : `${PAGES.length} 頁都沒有 noindex:${PAGES.map((x) => x.p).join("、")}`);
});
check("Worker 不在回應上加 X-Robots-Tag(頁面拿掉 noindex,標頭又加回去,結果一樣)", () => {
  const n = nonEmpty(SRC_TXT.filter(Boolean).length, "讀得到的 src/*.js"); if (n !== true) return n;
  const hit = SRC_TXT.filter((t) => t && /x-robots-tag|noindex/i.test(t)).length;
  return ok(hit === 0, hit ? `${hit} 個 src 檔提到 X-Robots-Tag 或 noindex` : `${SRC_TXT.filter(Boolean).length} 個 src 檔都沒有`);
});

// ───────────────────────────── M5:分享卡片、結構化資料、可被爬的文字 ─────────────────────────────
// orchestrator 裁決(#18–#21,2026-09-26):
//   網址用線上真正回 200 的那一個(rules.html 會 307 到 /rules,所以 canonical 是 /rules)。
//   卡片的標題 = 英文名 + 空格 + 中文名;描述 = seo.*.desc 的英文 + 空格 + 中文(en.js 裡不准有中文,所以雙語在頁面上組)。
//   分享圖兩張:封面一張、紙上空戰一張(規則頁用紙上空戰那張)。1200×630,png 或 jpg,≤ 300 KB(太大的圖有些聊天軟體不給預覽)。
//   VideoGame 的 JSON-LD 在紙上空戰那頁;封面是 WebSite,hasPart 裡有那個 VideoGame。
const ORIGIN_BG = "https://games.csiesheep.com/bored_games/";
const SPEC_URLS = { "index.html": ORIGIN_BG, "dogfight/index.html": ORIGIN_BG + "dogfight/", "dogfight/rules.html": ORIGIN_BG + "dogfight/rules" };
const SPEC_OG = { W: 1200, H: 630, MAX_BYTES: 300000 };
const SEO_KEYS = ["seo.about", "seo.cover.desc", "seo.dogfight.desc", "seo.rules.desc", "seo.cover.alt", "seo.dogfight.alt"];
const SEO_LEN = { "seo.about": [[150, 700], [60, 300]], desc: [[40, 130], [15, 60]], alt: [[20, 140], [8, 60]] }; // [en, zh] 字元數
const decodeEnt = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function attrsOf(tag) { const a = {}; tag.replace(/([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/g, (_, k, x, y, z) => { a[k.toLowerCase()] = decodeEnt(x ?? y ?? z ?? ""); return ""; }); return a; }
function headOf(html) {
  const metas = (html.match(/<meta\b[^>]*>/gi) || []).map(attrsOf), links = (html.match(/<link\b[^>]*>/gi) || []).map(attrsOf);
  const m = (k) => { const hit = metas.filter((a) => a.property === k || a.name === k); return hit.length === 1 ? hit[0].content : hit.length ? `(${hit.length} 個 ${k})` : undefined; };
  const canon = links.filter((a) => (a.rel || "").toLowerCase() === "canonical").map((a) => a.href);
  const ld = []; html.replace(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (_, j) => { try { ld.push(JSON.parse(j)); } catch (e) { ld.push({ __bad: e.message }); } return ""; });
  return { m, canon, ld };
}
async function readBytes(rel) {
  if (isNode) { const fs = await import("node:fs"); try { return new Uint8Array(fs.readFileSync(new URL(rel, import.meta.url))); } catch (e) { return null; } }
  const r = await fetch(new URL(rel, import.meta.url)); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
}
function imgSize(b) { // png 或 jpg 的寬高;其他格式 null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "png", w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1], len = b[i + 2] << 8 | b[i + 3];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(mk)) return { type: "jpg", h: b[i + 5] << 8 | b[i + 6], w: b[i + 7] << 8 | b[i + 8] };
      i += 2 + len;
    }
  }
  return null;
}
const OG_FILES = {};
for (const name of ["og-bored-games", "og-dogfight"]) for (const ext of ["jpg", "png"]) { const b = await readBytes(`../public/art/${name}.${ext}`); if (b) OG_FILES[`art/${name}.${ext}`] = b; }
const PAGE = Object.fromEntries(PAGES.map((x) => [x.p, x.html ? headOf(x.html) : null]));
const seoGate = () => { const g = gate(EN) || gate(ZH); if (g) return g; const en = EN.mod.default, zh = ZH.mod.default; if (!SEO_KEYS.some((k) => k in en || k in zh)) return "TODO: i18n 還沒有 seo.* 的字(#19)"; return null; };
const both = (k) => EN.mod.default[k] + " " + ZH.mod.default[k];
const cardGate = () => { if (!PAGES.some((x) => x.html && /og:title|rel=["']?canonical/i.test(x.html))) return "TODO: 頁面還沒有分享卡片(#20)"; return null; };

section("22 分享卡片、結構化資料、可被爬的文字");
check("seo.* 的 6 個 key:兩種語言都有、長度在範圍內(那一段 英文 150–700 / 中文 60–300 字;描述 40–130 / 15–60;圖說 20–140 / 8–60)", () => {
  const g = seoGate(); if (g) return g;
  const en = EN.mod.default, zh = ZH.mod.default, bad = [];
  for (const k of SEO_KEYS) {
    const [[a, b], [c, d]] = SEO_LEN[k] || SEO_LEN[k.endsWith(".alt") ? "alt" : "desc"];
    const le = (en[k] || "").length, lz = (zh[k] || "").length;
    if (le < a || le > b || lz < c || lz > d) bad.push(`${k}(en ${le},zh ${lz})`);
  }
  return ok(bad.length === 0, bad.length ? `缺或長度不對:${bad.join("、")}` : `6 個 key 都在;那一段 en ${en["seo.about"].length} / zh ${zh["seo.about"].length} 字`);
});
check("分享圖:public/art/og-bored-games 和 og-dogfight 各一張,1200×630,png 或 jpg,≤ 300 KB", () => {
  const names = Object.keys(OG_FILES); if (!names.length) return "TODO: public/art/ 還沒有分享圖(#18)";
  const bad = [], seen = [];
  for (const base of ["art/og-bored-games", "art/og-dogfight"]) {
    const hit = names.filter((n) => n.startsWith(base + "."));
    if (hit.length !== 1) { bad.push(`${base}.*:${hit.length} 張`); continue; }
    const b = OG_FILES[hit[0]], s = imgSize(b);
    if (!s || s.w !== SPEC_OG.W || s.h !== SPEC_OG.H || b.length > SPEC_OG.MAX_BYTES) bad.push(`${hit[0]}:${s ? `${s.type} ${s.w}×${s.h}` : "認不得的格式"},${b.length} bytes`);
    else seen.push(`${hit[0]} ${s.w}×${s.h} ${(b.length / 1000).toFixed(0)} KB`);
  }
  return ok(bad.length === 0, bad.length ? bad.join(";") : seen.join(";"));
});
check("每一頁的卡片:canonical 和 og:url = 那一頁真正的網址;og:type、og:title、og:description、og:image(寬高 1200×630、有 alt)、twitter:card = summary_large_image,twitter 的標題、描述、圖跟 og 一樣", () => {
  const g = cardGate(); if (g) return g;
  const bad = [];
  for (const p of SPEC_PAGES) {
    const h = PAGE[p]; if (!h) { bad.push(`${p}:讀不到`); continue; }
    const want = SPEC_URLS[p], m = h.m, miss = [];
    if (h.canon.length !== 1 || h.canon[0] !== want) miss.push(`canonical ${JSON.stringify(h.canon)}`);
    if (m("og:url") !== want) miss.push(`og:url ${m("og:url")}`);
    for (const k of ["og:type", "og:title", "og:description", "og:image", "og:image:alt", "twitter:title", "twitter:description", "twitter:image", "description"]) if (!m(k) || m(k).startsWith("(")) miss.push(`${k} ${m(k) ?? "沒有"}`);
    if (m("og:image:width") !== "1200" || m("og:image:height") !== "630") miss.push(`og:image 寬高 ${m("og:image:width")}×${m("og:image:height")}`);
    if (m("twitter:card") !== "summary_large_image") miss.push(`twitter:card ${m("twitter:card")}`);
    if (m("twitter:title") !== m("og:title") || m("twitter:description") !== m("og:description") || m("twitter:image") !== m("og:image")) miss.push("twitter 的標題/描述/圖跟 og 不一樣");
    if (m("description") !== m("og:description")) miss.push("meta description 跟 og:description 不一樣");
    if (miss.length) bad.push(`${p}:${miss.join(",")}`);
  }
  return ok(bad.length === 0, bad.length ? bad.join(";") : `${SPEC_PAGES.length} 頁的 canonical:${SPEC_PAGES.map((p) => SPEC_URLS[p].replace(ORIGIN_BG, "/")).join("、")}`);
});
check("卡片的字從 i18n 組出來:標題含英文名和中文名(規則頁再加兩種語言的「規則」);描述 = seo.*.desc 英文 + 空格 + 中文;圖說 = seo.*.alt 英文 + 空格 + 中文", () => {
  const g = cardGate() || seoGate(); if (g) return g;
  const en = EN.mod.default, zh = ZH.mod.default, bad = [];
  const plan = { "index.html": ["cover.title", "seo.cover.desc", "seo.cover.alt"], "dogfight/index.html": ["game.title", "seo.dogfight.desc", "seo.dogfight.alt"], "dogfight/rules.html": ["game.title", "seo.rules.desc", "seo.dogfight.alt"] };
  for (const p of SPEC_PAGES) {
    const m = PAGE[p].m, [t, d, a] = plan[p], title = m("og:title") || "";
    if (!title.includes(en[t]) || !title.includes(zh[t])) bad.push(`${p} og:title「${title}」沒有「${en[t]}」和「${zh[t]}」`);
    if (p.endsWith("rules.html") && !(title.includes(en["rules.title"]) && title.includes(zh["rules.title"]))) bad.push(`${p} og:title 沒有「${en["rules.title"]}」和「${zh["rules.title"]}」`);
    if (m("og:description") !== both(d)) bad.push(`${p} og:description ≠ ${d} 的英文 + 空格 + 中文`);
    if (m("og:image:alt") !== both(a)) bad.push(`${p} og:image:alt ≠ ${a} 的英文 + 空格 + 中文`);
  }
  return ok(bad.length === 0, bad.length ? bad.join(";") : `3 頁的標題、描述、圖說都對得上 i18n`);
});
check("og:image 指到 public/art/ 裡那兩張:封面用 og-bored-games,紙上空戰和規則頁用 og-dogfight", () => {
  const g = cardGate(); if (g) return g;
  const want = { "index.html": "art/og-bored-games.", "dogfight/index.html": "art/og-dogfight.", "dogfight/rules.html": "art/og-dogfight." }, bad = [];
  for (const p of SPEC_PAGES) {
    const u = PAGE[p].m("og:image") || "", rel = u.startsWith(ORIGIN_BG) ? u.slice(ORIGIN_BG.length) : null;
    if (!rel || !rel.startsWith(want[p]) || !OG_FILES[rel]) bad.push(`${p}:${u}${rel && !OG_FILES[rel] ? "(public/ 裡沒有這個檔)" : ""}`);
  }
  return ok(bad.length === 0, bad.length ? bad.join(";") : SPEC_PAGES.map((p) => `${p} → ${PAGE[p].m("og:image").slice(ORIGIN_BG.length)}`).join(";"));
});
check("JSON-LD:每一塊都讀得懂;紙上空戰那頁有 VideoGame(名字、url = canonical、image = og:image、描述 = og:description、inLanguage en + zh-Hant、playMode 單人和多人);封面是 WebSite,hasPart 有紙上空戰的 VideoGame", () => {
  const g = cardGate(); if (g) return g;
  const all = SPEC_PAGES.flatMap((p) => PAGE[p].ld.map((x) => [p, x])); if (!all.length) return "TODO: 頁面還沒有 JSON-LD(#20)";
  const broken = all.filter(([, x]) => x.__bad).map(([p, x]) => `${p}:${x.__bad}`); if (broken.length) return `讀不懂:${broken.join(";")}`;
  const flat = (x) => [].concat(x).flatMap((y) => (y && y["@graph"] ? y["@graph"] : [y]));
  const typeIs = (x, t) => [].concat(x["@type"]).includes(t), arr = (v) => [].concat(v ?? []);
  const bad = [], df = PAGE["dogfight/index.html"], vg = df.ld.flatMap(flat).filter((x) => typeIs(x, "VideoGame"));
  if (vg.length !== 1) bad.push(`紙上空戰那頁的 VideoGame 有 ${vg.length} 個`);
  else {
    const v = vg[0], en = EN.mod.default;
    if (!String(v.name || "").includes(en["game.title"])) bad.push(`name ${v.name}`);
    if (v.url !== SPEC_URLS["dogfight/index.html"]) bad.push(`url ${v.url}`);
    if (arr(v.image)[0] !== df.m("og:image")) bad.push(`image ${JSON.stringify(v.image)}`);
    if (v.description !== df.m("og:description")) bad.push("description ≠ og:description");
    if (!["en", "zh-Hant"].every((l) => arr(v.inLanguage).includes(l))) bad.push(`inLanguage ${JSON.stringify(v.inLanguage)}`);
    if (!["SinglePlayer", "MultiPlayer"].every((l) => arr(v.playMode).some((x) => String(x).endsWith(l)))) bad.push(`playMode ${JSON.stringify(v.playMode)}`);
  }
  const ws = PAGE["index.html"].ld.flatMap(flat).filter((x) => typeIs(x, "WebSite"));
  if (ws.length !== 1) bad.push(`封面的 WebSite 有 ${ws.length} 個`);
  else if (ws[0].url !== ORIGIN_BG || !arr(ws[0].hasPart).some((x) => x && typeIs(x, "VideoGame") && x.url === SPEC_URLS["dogfight/index.html"])) bad.push(`封面 WebSite:url ${ws[0].url},hasPart 裡沒有 url 是紙上空戰的 VideoGame`);
  return ok(bad.length === 0, bad.length ? bad.join(";") : `${all.length} 塊 JSON-LD 都讀得懂;VideoGame 和 WebSite 的欄位都對`);
});
check("封面上可被爬的那一段:不跑 JavaScript 的靜態 HTML 裡,lang=\"en\" 和 lang=\"zh-Hant\" 各有一個元素,字跟 seo.about 一字不差(不算 script / noscript / template 裡的)", () => {
  const g = seoGate(); if (g) return g;
  const html = PAGES.find((x) => x.p === "index.html").html.replace(/<(script|noscript|template)\b[\s\S]*?<\/\1>/gi, "");
  const norm = (s) => decodeEnt(String(s).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  const found = (lang) => { const re = new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\blang\\s*=\\s*["']${lang}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "gi"); const out = []; let mm; while ((mm = re.exec(html))) { out.push(norm(mm[2])); re.lastIndex = mm.index + 1; } return out; }; // 可以重疊:<html lang="zh-Hant"> 會包住整頁
  const en = norm(EN.mod.default["seo.about"]), zh = norm(ZH.mod.default["seo.about"]);
  const fe = found("en").filter((t) => t === en).length, fz = found("zh-Hant").filter((t) => t === zh).length;
  if (!fe && !fz && !/og:title|canonical/i.test(html)) return "TODO: 封面還沒有那一段(#20)";
  return ok(fe === 1 && fz === 1, `英文那段 ${fe} 個、中文那段 ${fz} 個(各要 1 個)`);
});

// ───────────────────────────── M5:sitemap ─────────────────────────────
// orchestrator 裁決(#21):/bored_games/sitemap.xml 由 Worker 回;網址 = SPEC_URLS 那 3 個,每個有 lastmod。
const WORKER = await tryImport("../src/index.js");
async function hitWorker(path) { // 用假的 ASSETS 叫 Worker;ASSETS 回 404 並記下它被叫的路徑
  const seen = [];
  const env = { ASSETS: { fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response("asset-stub", { status: 404 }); } } };
  const res = await WORKER.mod.default.fetch(new Request("https://games.csiesheep.com" + path), env);
  return { status: res.status, type: res.headers.get("content-type") || "", body: await res.text(), seen };
}
const SM = gate(WORKER) ? null : await hitWorker("/bored_games/sitemap.xml");
const SM_PAGE = gate(WORKER) ? null : await hitWorker("/bored_games/dogfight/");
section("23 sitemap");
check("/bored_games/sitemap.xml:200、application/xml;<loc> 正好是那 3 個網址,各一次;每個都有 2026-09-25 之後的 lastmod(YYYY-MM-DD)", () => {
  const g = gate(WORKER); if (g) return g;
  if (SM.status === 404 && SM.seen.length) return "TODO: Worker 還沒有 sitemap(#21)——請求落到了靜態檔";
  if (SM.status !== 200 || !/^application\/xml/.test(SM.type)) return `status ${SM.status}、content-type ${SM.type}`;
  const urls = [...SM.body.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((u) => ({ loc: (u[1].match(/<loc>([^<]*)<\/loc>/) || [])[1], lastmod: (u[1].match(/<lastmod>([^<]*)<\/lastmod>/) || [])[1] }));
  const n = nonEmpty(urls.length, "sitemap 裡的 <url>"); if (n !== true) return n;
  const want = Object.values(SPEC_URLS).sort(), got = urls.map((u) => u.loc).sort();
  const badMod = urls.filter((u) => !/^\d{4}-\d{2}-\d{2}$/.test(u.lastmod || "") || u.lastmod < "2026-09-25");
  if (!/^<\?xml[^>]*\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(SM.body)) return "開頭不是 <?xml …?> + sitemaps.org 的 <urlset>";
  return ok(JSON.stringify(got) === JSON.stringify(want) && badMod.length === 0, JSON.stringify(got) !== JSON.stringify(want) ? `loc ${JSON.stringify(got)},應該是 ${JSON.stringify(want)}` : badMod.length ? `lastmod 不對:${badMod.map((u) => `${u.loc} ${u.lastmod}`).join("、")}` : `${urls.length} 個網址:${urls.map((u) => `${u.loc.replace(ORIGIN_BG, "/")} ${u.lastmod}`).join("、")}`);
});
check("sitemap 裡的每一頁都不是 noindex(交叉:sitemap 的網址 → public/ 的頁 → 沒有 robots noindex)", () => {
  const g = gate(WORKER); if (g) return g;
  if (SM.status !== 200) return "TODO: Worker 還沒有 sitemap(#21)";
  const locs = [...SM.body.matchAll(/<loc>([^<]*)<\/loc>/g)].map((x) => x[1]);
  const n = nonEmpty(locs.length, "sitemap 的網址"); if (n !== true) return n;
  const byUrl = Object.fromEntries(Object.entries(SPEC_URLS).map(([p, u]) => [u, p]));
  const bad = locs.filter((u) => { const p = byUrl[u], x = PAGES.find((y) => y.p === p); return !x || !x.html || (x.html.match(NOINDEX) || []).some((mm) => /noindex/i.test(mm)); });
  return ok(bad.length === 0, bad.length ? `不在表上或是 noindex:${bad.join("、")}` : `${locs.length} 個網址都對到一頁、都沒有 noindex`);
});
check("加了 sitemap 之後,其他路徑照舊交給靜態檔:/bored_games/dogfight/ → ASSETS 收到 /dogfight/", () => {
  const g = gate(WORKER); if (g) return g;
  return ok(JSON.stringify(SM_PAGE.seen) === '["/dogfight/"]', `ASSETS 收到 ${JSON.stringify(SM_PAGE.seen)},回 ${SM_PAGE.status}`);
});
// BE 在 #21 回報的洞:沒有一列打 /ws、前綴的 301、Location 補前綴。加 sitemap 的路由最容易順手吃掉的就是這些。
// 期望值從 src/index.js 的註解和 M4 的規格抄(房間碼四個大寫字母、沒有 I 和 O),不從產品讀。
async function route(path, assets) { // assets(pathname) → Response;記下 ASSETS 被叫的路徑
  const seen = [];
  const env = { ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; seen.push(p); return assets ? assets(p) : new Response("asset-stub", { status: 404 }); } } };
  const res = await WORKER.mod.default.fetch(new Request("https://games.csiesheep.com" + path), env);
  return { status: res.status, loc: res.headers.get("location"), seen };
}
const ROUTES = gate(WORKER) ? null : {
  root: await route("/"),
  bare: await route("/bored_games"),
  wsBad: await route("/bored_games/ws?room=kqrt"),
  wsNoUp: await route("/bored_games/ws?room=KQRT"),
  away: await route("/zongheng/"),
  redir: await route("/bored_games/dogfight/rules.html", (p) => (p === "/dogfight/rules.html" ? new Response(null, { status: 307, headers: { location: "https://games.csiesheep.com/dogfight/rules" } }) : new Response("x", { status: 404 }))),
};
check("路由照舊:/ 和 /bored_games → 301 到 /bored_games/;/ws 房間碼不合格 400、合格但沒有升級 426(都不經過 ASSETS);前綴外 404;靜態檔的轉址補回前綴", () => {
  const g = gate(WORKER); if (g) return g;
  const R = ROUTES, want = "https://games.csiesheep.com/bored_games/", bad = [];
  if (R.root.status !== 301 || R.root.loc !== want) bad.push(`/ → ${R.root.status} ${R.root.loc}`);
  if (R.bare.status !== 301 || R.bare.loc !== want) bad.push(`/bored_games → ${R.bare.status} ${R.bare.loc}`);
  if (R.wsBad.status !== 400 || R.wsBad.seen.length) bad.push(`/ws?room=kqrt → ${R.wsBad.status},ASSETS ${JSON.stringify(R.wsBad.seen)}`);
  if (R.wsNoUp.status !== 426 || R.wsNoUp.seen.length) bad.push(`/ws?room=KQRT(沒有升級)→ ${R.wsNoUp.status},ASSETS ${JSON.stringify(R.wsNoUp.seen)}`);
  if (R.away.status !== 404 || R.away.seen.length) bad.push(`/zongheng/ → ${R.away.status},ASSETS ${JSON.stringify(R.away.seen)}`);
  if (R.redir.status !== 307 || R.redir.loc !== want + "dogfight/rules") bad.push(`rules.html → ${R.redir.status} ${R.redir.loc}`);
  return ok(bad.length === 0, bad.length ? bad.join(";") : `/ 301、/bored_games 301、ws 400 / 426、前綴外 404、rules.html 307 → ${R.redir.loc.replace("https://games.csiesheep.com", "")}`);
});
