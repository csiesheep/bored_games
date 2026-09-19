// 紙上空戰的電腦對手:純函式,瀏覽器(單人)和房間(逾時 / 斷線代打)共用。
//
// 只 import ./engine.js,不用任何 Node API。
//
// 不可協商的兩件事(orchestrator 裁決 #3):
//   1. bot 不看 view.seed / view.rng,也不拿 view 去 apply。state 的 rng 決定下一手確切的
//      長度誤差和弧度:拿它去模擬,40 次 Monte Carlo 會是同一條線,而且就是真的會發生的
//      那一條——那不是估機率,是偷看答案,量出來的階梯是假的。模擬用 bot 自己的亂數抽
//      lenErr 和 curv,配引擎匯出的 trace() / onPaper() / RULES。
//   2. choose 是決定性的純函式:亂數只來自 seed 參數,不碰 Math.random / Date /
//      模組層級的可變狀態,也不改傳進來的 view。錯了模擬重現不了,房間裡代打的那一手
//      也重播不了。
//
// 數值的出處:等級的瞄準雜訊(±12° / ±6° / ±2.5°)和「每個候選 40 次 Monte Carlo」抄自
// 計畫 Bots and balance(vault: Projects/bored_games/bored_games plan.md);規則的數值一律
// 走 engine.js 的 RULES,這個檔案裡沒有第二份。

import { RULES, trace, onPaper } from "./engine.js";

// 三個等級。aimNoiseDeg 是計畫指定的;其餘三個旋鈕是 BE 定的(#3 授權)。
//   mc          每個候選跑幾次 Monte Carlo(計畫的基準是 40)
//   exposureMc  估「停在那裡會不會被對方下一手打中」跑幾次
//   exposureW   曝險在分數裡的權重(分數 = 擊毀 − 出界 − 曝險 × 權重)
export const LEVELS = {
  easy: { aimNoiseDeg: 12, mc: 20, exposureMc: 0, exposureW: 0 },
  normal: { aimNoiseDeg: 6, mc: 40, exposureMc: 12, exposureW: 0.8 },
  hard: { aimNoiseDeg: 2.5, mc: 120, exposureMc: 24, exposureW: 1.5 },
};

// why 的代碼(#3 的第一則留言列過):選中的那一手的估計擊毀機率決定印哪一個。
export const WHY = ["close_shot", "snipe", "advance", "desperate"];
const WHY_CLOSE = 0.5; // pKill ≥ 這個 → close_shot
const WHY_SNIPE = 0.12; // pKill ≥ 這個 → snipe;以下看分數是正是負

// 分數裡的位置項:同分時往敵機靠。沒有它,一整盤沒有好手的時候 bot 會停在原地互看。
const POS_W = 0.06;
// 只有基礎分前 TOP_K 名的候選要算曝險(曝險只會扣分,算全部只是慢)。
const TOP_K = 8;

const DEG = Math.PI / 180;
const HIT2 = RULES.HIT * RULES.HIT;
const DIAG = Math.sqrt(RULES.W * RULES.W + RULES.H * RULES.H);

// mulberry32,種子只來自 choose 的 seed 參數。
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    let t = (s = (s + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 名目長度 → pr(RULES 的 MIN_LEN / MAX_LEN,夾在 [0,1])
function prFor(len) {
  const pr = (len - RULES.MIN_LEN) / (RULES.MAX_LEN - RULES.MIN_LEN);
  return pr < 0 ? 0 : pr > 1 ? 1 : pr;
}

// 線上離 (tx,ty) 最近那一點的距離平方
function nearest2(pts, tx, ty) {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - tx;
    const dy = pts[i].y - ty;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}

// 抽 n 組引擎的誤差:lenErr ∈ 1±LEN_ERR、curv ∈ ±CURVE,都均勻(規則筆記「出手的數值」)。
// 同一次 choose 裡所有候選共用同一組樣本(common random numbers):比較才公平,也省一半亂數。
function errorSamples(rnd, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = [1 + (rnd() * 2 - 1) * RULES.LEN_ERR, (rnd() * 2 - 1) * RULES.CURVE];
  }
  return out;
}

// 停在 end 之後,活下來的敵機下一手打中我的機率。敵機瞄得準(保守),誤差照引擎的分布。
// surv[j] 是這一手打完之後第 j 架敵機還活著的機率——把「打死它就不會被它打」算進來。
function exposureAt(end, foes, surv, samples) {
  if (!samples.length || !onPaper(end)) return 0;
  let safe = 1;
  for (let j = 0; j < foes.length; j++) {
    if (surv[j] <= 0.001) continue;
    const f = foes[j];
    const dx = end.x - f.x;
    const dy = end.y - f.y;
    const ang = Math.atan2(dy, dx);
    const pr = prFor(Math.sqrt(dx * dx + dy * dy));
    let hit = 0;
    for (let i = 0; i < samples.length; i++) {
      const pts = trace(f.x, f.y, ang, pr, samples[i][0], samples[i][1]);
      if (nearest2(pts, end.x, end.y) < HIT2) hit++;
    }
    safe *= 1 - surv[j] * (hit / samples.length);
  }
  return 1 - safe;
}

/**
 * 選一手。view 是 engine.view(state, seat)(有沒有 seed / rng 都一樣跑,也一定不看)。
 * 回傳 { type:'fire', plane, ang, pr, why },一定是 apply 會接受的手。
 */
export function choose(view, seat, level, seed) {
  const cfg = LEVELS[level];
  if (!cfg) throw new Error(`unknown level: ${level}`);
  const rnd = mulberry32(seed);

  const mine = view.planes.filter((p) => p.side === seat && p.alive);
  const foes = view.planes.filter((p) => p.side !== seat && p.alive);
  if (!mine.length) throw new Error("no plane to move");

  const noise = () => (rnd() * 2 - 1) * cfg.aimNoiseDeg * DEG;
  // 敵機都沒了就沒有局了(引擎會先 over);留一條不會丟出來的路。
  if (!foes.length) {
    return { type: "fire", plane: mine[0].id, ang: mine[0].ang + noise(), pr: 0, why: "advance" };
  }

  // ── 候選:(自己的飛機 × 對方的飛機) × 六種力道。角度一律是對準那架敵機中心的方位,
  //    雜訊最後才加(契約:先決定想瞄的角度)。六種力道裡 dist−120 / dist·0.55 / pr=0
  //    就是「不指望打中、往前挪」的手:停在對方的反擊圈外面。
  const cands = [];
  for (const m of mine) {
    for (const f of foes) {
      const dx = f.x - m.x;
      const dy = f.y - m.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ang = Math.atan2(dy, dx);
      const seen = new Set();
      for (const len of [dist, dist + 60, dist * 0.8, dist - 120, dist * 0.55, 0]) {
        const pr = Math.round(prFor(len) * 1e6) / 1e6;
        if (seen.has(pr)) continue;
        seen.add(pr);
        cands.push({ id: m.id, x: m.x, y: m.y, ang, pr });
      }
    }
  }

  const samples = errorSamples(rnd, cfg.mc);
  const expSamples = errorSamples(rnd, cfg.exposureMc);
  const n = samples.length;

  for (const c of cands) {
    let kills = 0; // 擊毀的架次總和(一條線可以毀掉不只一架)
    let any = 0; // 至少毀掉一架的次數
    let out = 0; // 自己飛出紙外的次數
    const dead = new Array(foes.length).fill(0);
    for (let i = 0; i < n; i++) {
      const pts = trace(c.x, c.y, c.ang, c.pr, samples[i][0], samples[i][1]);
      let got = 0;
      for (let j = 0; j < foes.length; j++) {
        if (nearest2(pts, foes[j].x, foes[j].y) < HIT2) {
          got++;
          dead[j]++;
        }
      }
      kills += got;
      if (got) any++;
      if (!onPaper(pts[pts.length - 1])) out++;
    }
    c.expKills = kills / n;
    c.pKill = any / n;
    c.pOut = out / n;
    c.surv = dead.map((k) => 1 - k / n);

    // 名目的落點(沒有誤差)拿來估曝險和「離敵機多近」。
    const ptsN = trace(c.x, c.y, c.ang, c.pr, 1, 0);
    c.end = ptsN[ptsN.length - 1];
    let near = Infinity;
    for (const f of foes) {
      const d = Math.hypot(f.x - c.end.x, f.y - c.end.y);
      if (d < near) near = d;
    }
    c.base = c.expKills - c.pOut + POS_W * (1 - Math.min(1, near / DIAG));
  }

  // 分數 = 擊毀 − 出界 − 曝險 × 權重(+ 位置項)。曝險只算基礎分前 TOP_K 名。
  cands.sort((a, b) => b.base - a.base);
  const pool = cands.slice(0, TOP_K);
  for (const c of pool) {
    c.exposure = cfg.exposureW > 0 ? exposureAt(c.end, foes, c.surv, expSamples) : 0;
    c.score = c.base - cfg.exposureW * c.exposure;
  }
  let best = pool[0];
  for (const c of pool) if (c.score > best.score) best = c;

  const why =
    best.pKill >= WHY_CLOSE ? "close_shot" : best.pKill >= WHY_SNIPE ? "snipe" : best.score >= 0 ? "advance" : "desperate";

  // 有界的雜訊,±aimNoiseDeg 之內、均勻(不是高斯):模擬人在擺動中抓時機的誤差。
  return { type: "fire", plane: best.id, ang: best.ang + noise(), pr: best.pr, why };
}
