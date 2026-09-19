// tests/sim.js — 平衡 harness。BE 所有(TEAM.md 的所有權表);其餘 tests/ 是 orchestrator 的。
//
//   node tests/sim.js <games> <cell>
//
// cell 是下面 CELLS 的 key,或 all(依序跑六格)。每一格量:
//   勝負    座位 0 勝 / 座位 1 勝 / 平手,外加「先報的那個等級」拿到的分數(平手算半分)
//   結局    wipe(最後一架被打下來)/ crash(最後一架自己飛出紙外)/ cap(兩邊都出滿 30 手或平手),
//           外加輸家三架各自是被打的還是自摔的
//   出手數  p10 / p50 / p90 / max / mean(分布,不是只有平均)
//   耗時    每個等級 choose 的平均和最慢(ms)
//
// 三張表:
//   等級階梯   ladder:* 三格,目標 hard 對 easy ≥ 75%
//   先手勝率   mirror:* 三格的座位 0 勝率,目標 50% ± 5%(量出來回報,不調 bot 去湊)
//   每局出手數 每一格都有,目標 8 到 16
//
// 可重現:第 i 局的種子只是 i 的函式(gameSeed),bot 的種子只是 (gameSeed, 第幾手) 的函式,
// 而且先手是照 i 的奇偶輪流的。所以同一格重跑數字一樣,跟局數的切法、跑的順序都無關。
//
// 子行程:這台機器上 Node 24 長時間跑會 access violation,所以每 CHUNK 局開一個子行程,
// 當掉就整塊原樣重跑(種子是 i 的函式,重跑出來一樣)。
//
// 這個檔案不是 node --test 會撿的檔名(*.test.js / test-*.js / test.js / test/**),
// 所以 npm test 不會把它當測試跑起來。

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as E from "../public/shared/dogfight/engine.js";
import * as B from "../public/shared/dogfight/bots.js";

const CELLS = {
  "ladder:hard-vs-easy": ["hard", "easy"],
  "ladder:hard-vs-normal": ["hard", "normal"],
  "ladder:normal-vs-easy": ["normal", "easy"],
  "mirror:easy": ["easy", "easy"],
  "mirror:normal": ["normal", "normal"],
  "mirror:hard": ["hard", "hard"],
};
const CHUNK = 50;

// 第 i 局的種子:i 的固定函式。
const gameSeed = (i) => (i * 7919 + 104729) | 0;
// 第 i 局第 ply 手的 bot 種子:(局種子, ply) 的固定函式。
const botSeed = (gs, ply) => (Math.imul(gs, 2654435761) ^ Math.imul(ply + 1, 40503)) | 0;
// 輪流先手:偶數局第一個等級坐座位 0,奇數局換過來。
const seatsFor = (pair, i) => (i % 2 === 0 ? [pair[0], pair[1]] : [pair[1], pair[0]]);

// bot 只拿得到 view,而且是拿掉 seed / rng 的 view(#3 的約束;#2 還沒裁決 view 要不要藏,
// 所以這裡自己拿掉——bot 兩種都要能跑)。
function blind(st, seat) {
  const v = E.view(st, seat);
  delete v.seed;
  delete v.rng;
  return v;
}

function playGame(i, pair, timing) {
  const seed = gameSeed(i);
  const levels = seatsFor(pair, i);
  let st = E.setup(seed);
  let plies = 0;
  let lastSeat = -1;
  while (!st.over && plies < 2 * E.RULES.MAX_SHOTS) {
    const seat = st.turn;
    lastSeat = seat;
    const level = levels[seat];
    const t0 = process.hrtime.bigint();
    const a = B.choose(blind(st, seat), seat, level, botSeed(seed, plies));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const t = (timing[level] ||= { n: 0, sum: 0, max: 0 });
    t.n++;
    t.sum += ms;
    if (ms > t.max) t.max = ms;
    st = E.apply(st, a);
    plies++;
  }
  return {
    i,
    seed,
    levels,
    plies,
    winner: st.winner,
    over: st.over,
    ending: endingOf(st, lastSeat),
    lossBy: lossBy(st),
    shots: st.shots.slice(),
  };
}

// 結局:兩邊都出滿 MAX_SHOTS(或平手)是 cap;否則看輸家的最後一架是怎麼沒的。
// 出手的人不會打到自己人,所以最後一手是輸家出的 → 那一架是自己飛出紙外(crash);
// 最後一手是贏家出的 → 是被打下來的(wipe)。這比「三架全是自己摔的」會分:
// 後者在贏家順手打下一架的時候就永遠是 wipe(證偽時量到 200 局只有 1 局算 crash)。
function endingOf(st, lastSeat) {
  if (!st.over) return "unfinished";
  if (st.winner === null) return "cap";
  if (st.shots[0] >= E.RULES.MAX_SHOTS && st.shots[1] >= E.RULES.MAX_SHOTS) return "cap";
  return lastSeat === 1 - st.winner ? "crash" : "wipe";
}

// 輸家三架各自是怎麼沒的(lost=true 自己飛出紙外,by!=null 被對方的線打到)。
// 結局只看最後一架,這一欄看全部——「最後被打下來」和「一路都是自己摔的」不是同一回事。
function lossBy(st) {
  const out = { shot: 0, crashed: 0, alive: 0 };
  if (st.winner === null) return out;
  for (const p of st.planes) {
    if (p.side === st.winner) continue;
    if (p.alive) out.alive++;
    else if (p.lost) out.crashed++;
    else out.shot++;
  }
  return out;
}

// 最近排名法:p10 是排序後第 ceil(0.10 · n) 個。
function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

function aggregate(cell, pair, rows, timing) {
  const shots = rows.map((r) => r.plies).sort((a, b) => a - b);
  const wins = [0, 0];
  let draws = 0;
  const ending = { wipe: 0, crash: 0, cap: 0, unfinished: 0 };
  const lost = { shot: 0, crashed: 0, alive: 0 };
  let firstScore = 0; // pair[0] 那個等級拿到的分數,平手算半分
  for (const r of rows) {
    ending[r.ending]++;
    lost.shot += r.lossBy.shot;
    lost.crashed += r.lossBy.crashed;
    lost.alive += r.lossBy.alive;
    if (r.winner === null) {
      draws++;
      firstScore += 0.5;
    } else {
      wins[r.winner]++;
      if (r.levels[r.winner] === pair[0] && pair[0] !== pair[1]) firstScore += 1;
      else if (pair[0] === pair[1] && r.winner === 0) firstScore += 1;
    }
  }
  const n = rows.length;
  const ms = {};
  for (const [lvl, t] of Object.entries(timing)) ms[lvl] = { avg: +(t.sum / t.n).toFixed(3), max: +t.max.toFixed(3), n: t.n };
  return {
    cell,
    pair,
    games: n,
    seat0: wins[0],
    seat1: wins[1],
    draws,
    seat0Pct: +((100 * (wins[0] + draws / 2)) / n).toFixed(1),
    firstLevel: pair[0],
    firstLevelPct: +((100 * firstScore) / n).toFixed(1),
    ending: { wipe: ending.wipe, crash: ending.crash, cap: ending.cap },
    loserPlanes: lost,
    shots: {
      p10: pct(shots, 0.1),
      p50: pct(shots, 0.5),
      p90: pct(shots, 0.9),
      max: shots[shots.length - 1],
      mean: +(shots.reduce((a, b) => a + b, 0) / n).toFixed(2),
    },
    chooseMs: ms,
  };
}

function runChunk(cell, from, to) {
  const pair = CELLS[cell];
  const timing = {};
  const rows = [];
  for (let i = from; i < to; i++) rows.push(playGame(i, pair, timing));
  return { rows, timing };
}

// ───────────────────────── 子行程 ─────────────────────────
const argv = process.argv.slice(2);
if (argv[0] === "--chunk") {
  const [, cell, from, to] = argv;
  const r = runChunk(cell, +from, +to);
  process.stdout.write("#OUT " + JSON.stringify(r) + "\n");
  process.exit(0);
}

// ───────────────────────── 母行程 ─────────────────────────
const SELF = fileURLToPath(import.meta.url);

function runCell(cell, games) {
  const rows = [];
  const timing = {};
  for (let from = 0; from < games; from += CHUNK) {
    const to = Math.min(games, from + CHUNK);
    let got = null;
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      const p = spawnSync(process.execPath, [SELF, "--chunk", cell, String(from), String(to)], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      const line = (p.stdout || "").split("\n").find((l) => l.startsWith("#OUT "));
      if (p.status === 0 && line) got = JSON.parse(line.slice(5));
      else process.stderr.write(`[retry ${attempt}] ${cell} ${from}-${to} exit=${p.status} signal=${p.signal}\n`);
    }
    if (!got) throw new Error(`${cell} ${from}-${to}: 子行程三次都沒跑完`);
    rows.push(...got.rows);
    for (const [lvl, t] of Object.entries(got.timing)) {
      const acc = (timing[lvl] ||= { n: 0, sum: 0, max: 0 });
      acc.n += t.n;
      acc.sum += t.sum;
      if (t.max > acc.max) acc.max = t.max;
    }
  }
  return aggregate(cell, CELLS[cell], rows, timing);
}

function printCell(a) {
  const t = Object.entries(a.chooseMs)
    .map(([l, m]) => `${l} ${m.avg}/${m.max}`)
    .join("  ");
  console.log(
    `${a.cell.padEnd(22)} ${String(a.games).padStart(4)} 局  ` +
      `座位0 ${String(a.seat0).padStart(3)} / 座位1 ${String(a.seat1).padStart(3)} / 平 ${String(a.draws).padStart(3)}  ` +
      `座位0 ${String(a.seat0Pct).padStart(5)}%  ${a.firstLevel} ${String(a.firstLevelPct).padStart(5)}%  ` +
      `結局 wipe ${a.ending.wipe} / crash ${a.ending.crash} / cap ${a.ending.cap}  ` +
      `輸家的飛機 被打 ${a.loserPlanes.shot} / 自摔 ${a.loserPlanes.crashed} / 還活著 ${a.loserPlanes.alive}  ` +
      `出手數 p10 ${a.shots.p10} p50 ${a.shots.p50} p90 ${a.shots.p90} max ${a.shots.max} mean ${a.shots.mean}  ` +
      `choose ms(avg/max) ${t}`
  );
}

const games = Number(argv[0] || 200);
const which = argv[1] || "all";
if (!Number.isInteger(games) || games < 1) {
  console.error("用法:node tests/sim.js <games> <cell>;cell 是 " + Object.keys(CELLS).join(" / ") + " 或 all");
  process.exit(2);
}
const cells = which === "all" ? Object.keys(CELLS) : [which];
for (const c of cells) {
  if (!CELLS[c]) {
    console.error(`不認得的 cell:${c};有的是 ${Object.keys(CELLS).join(" / ")} 或 all`);
    process.exit(2);
  }
}

const t0 = Date.now();
const out = [];
for (const c of cells) {
  const a = runCell(c, games);
  printCell(a);
  out.push(a);
}
console.log(`# ${games} 局 × ${cells.length} 格,${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
console.log(JSON.stringify({ games, cells: out }));
