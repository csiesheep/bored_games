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
    const st0 = E.setup(seed), me = plane(st0, 1), ang = ((seed % 6283) / 1000) - Math.PI;
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
    const a = fire(place(E.setup(seed), { 0: [300, 600], 3: [300 + 23.99, 600] }), 0, -Math.PI / 2, 0);
    const b = fire(place(E.setup(seed), { 0: [300, 600], 3: [300 + 24, 600] }), 0, -Math.PI / 2, 0);
    if (!plane(a, 3).alive) hit++;
    if (plane(b, 3).alive) miss++;
  }
  return ok(hit === SEEDS.length && miss === SEEDS.length, `23.99:${hit} / ${SEEDS.length} 毀;24:${miss} / ${SEEDS.length} 沒事`);
});
check("命中半徑 24:線中段(沿線 50)旁邊 20 的一定毀,旁邊 27 的一定不毀", () => {
  // pr=0:線長 94 到 106,取樣間距 ≤ 3.6,沿線 50 處的弧度偏移 ≤ 2.7。20 → 最遠 22.8 < 24;27 → 最近 24.3 > 24。
  let hit = 0, miss = 0;
  for (const seed of SEEDS) for (const side of [-1, 1]) {
    const a = fire(place(E.setup(seed), { 0: [300, 600], 3: [300 + side * 20, 550] }), 0, -Math.PI / 2, 0);
    const b = fire(place(E.setup(seed), { 0: [300, 600], 3: [300 + side * 27, 550] }), 0, -Math.PI / 2, 0);
    if (!plane(a, 3).alive && plane(a, 3).by === 0) hit++;
    if (plane(b, 3).alive) miss++;
  }
  return ok(hit === SEEDS.length * 2 && miss === SEEDS.length * 2, `旁邊 20:${hit} / ${SEEDS.length * 2} 毀;旁邊 27:${miss} / ${SEEDS.length * 2} 沒事`);
});
check("一條線可以毀掉不只一架:正前方 100 和 200 各一架、名目長度 600,兩架都毀,遠處那架沒事", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st = fire(place(E.setup(seed), { 0: [300, 850], 3: [300, 750], 4: [300, 650], 5: [560, 40] }), 0, -Math.PI / 2, prFor(600));
    const d = [3, 4, 5].map((id) => plane(st, id));
    if (d[0].alive || d[1].alive || !d[2].alive || d[0].by !== 0 || d[1].by !== 0) return `seed ${seed}: 3 號 alive=${d[0].alive}、4 號 alive=${d[1].alive}、5 號 alive=${d[2].alive}`;
    n++;
  }
  return ok(n === SEEDS.length, `${n} / ${SEEDS.length} 個種子一線兩架`);
});
check("殘骸不擋線(未知數 #2):前面那架早就毀了,後面那架照樣被打到;殘骸留在原地", () => {
  let n = 0;
  for (const seed of SEEDS) {
    const st0 = place(E.setup(seed), { 0: [300, 850], 3: [300, 750], 4: [300, 650], 5: [560, 40] });
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
  let st = E.setup(7), n = 0;
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
  const st = place(E.setup(3), { 2: null });
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
    const st = fire(place(E.setup(seed), { 1: [300, 450] }), 1, ang, 0.1);
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
    let st = fire(place(E.setup(seed), { 0: [300, 600], 3: [60, 60], 4: [540, 60], 5: [60, 200] }), 0, -Math.PI / 2, prFor(400));
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
  const st = fire(place(E.setup(5), { 0: [300, 120], 3: [300, 60] }), 0, -Math.PI / 2, 1);
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
    const st = fire(place(E.setup(seed), { 0: [300, 120], 1: null, 2: null, 3: [300, 60], 4: null, 5: null }), 0, -Math.PI / 2, 1);
    if (!(st.over && st.winner === 0 && !plane(st, 0).alive && !plane(st, 3).alive)) return `seed ${seed}: over=${st.over} winner=${st.winner} 我=${plane(st, 0).alive} 敵=${plane(st, 3).alive}`;
    n++;
  }
  return ok(n === SEEDS.length, `${n} / ${SEEDS.length} 個種子:兩邊都沒飛機了,出手的座位 0 贏`);
});
check("自己最後一架飛出紙外、對方還有飛機:對方贏;結束之後誰都沒有手,再出手會被拒絕", () => {
  const st = fire(place(E.setup(9), { 0: null, 1: null }), 2, Math.PI / 2, 1);
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
const capStart = (seed, spots = {}) => place(E.setup(seed), { 1: [300, 700], 4: [300, 200], ...spots });
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
  const states = [E.setup(11), shuffle(capStart(11), 7), fire(place(E.setup(9), { 0: null, 1: null }), 2, Math.PI / 2, 1)];
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
  return ok(throws(() => E.replay(rec.seed, bad)) && throws(() => E.replay(rec.seed, dup)), "力道 2 的一手、不是自己回合的一手,都讓 replay 丟出來");
});
