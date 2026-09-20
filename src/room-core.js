// 房間的核心:一個純函式,兩個座位,規則全部在這裡。
//
// 為什麼是純函式(orchestrator 裁決 #12):WebSocket、alarm、storage 在部署之前幾乎沒辦法
// 自動驗,所以規則一條都不放在 Durable Object 裡。這個檔案不 import DOM / Node / Workers 的
// 東西,不碰 `Date`、`Math.random`、`crypto`——時鐘(`now`)和亂數(`rand`)一律由呼叫的人
// 給。驗收(tests/acceptance.js 第 17 組)因此可以在 node 裡把整個房間走完。
//
// 規則只有引擎一份:命中、出界、誰先手、什麼時候結束,全部問 `engine.apply` / `setup`;
// 這裡不自己判斷任何一條。畫(art)交給 `engine.setup` 驗,核心不寫第二份檢查。
//
//   step(room, ev, now, rand) → { room, out: [{ to: token, msg }] }
//
// `step` 不改傳進來的 room(JSON clone;這台機器上 structuredClone 會當)。`rand()` 回傳
// uint32,只有開新的一局會用到它。
//
// 送出去的只有 `engine.view`(owner 裁決 #2:view 永遠沒有 seed / rng)。`room.state`、
// `room.log.seed` 不出現在 `out` 裡——客戶端拿得到 rng 就算得出對手下一手確切的那條線。
//
// `room.wake` 是「下一件會自己發生的事」的時間。排程和執行都走同一個 `due()`:漏掉一項
// 不只是忘了排,連做都不會做——房間卡在那裡等一個永遠不會來的 tick 這件事,結構上不可能
// 只發生在排程那一側。
//
// 座位訊息裡的 `online` 只在 `kind === "human"` 的時候有意義(電腦的座位永遠 false)。
//
// 每一則 `state` 都帶伺服器的 `now`:`deadline` 是絕對時間,客戶端的時鐘跟伺服器差幾秒是
// 常態(orchestrator 線上實測差了 3 秒多),所以倒數只能用 `deadline − now`。

import { setup, apply, view, clone } from "../public/shared/dogfight/engine.js";
import { choose } from "../public/shared/dogfight/bots.js";

// 回合 30 秒、斷線 20 秒電腦接手:計畫的 Architecture。其餘 orchestrator 裁決(#12)。
export const ROOM = {
  TURN_MS: 30000,
  OFFLINE_MS: 20000,
  BOT_DELAY_MS: 1200,
  IDLE_MS: 600000,
  BOT_LEVEL: "normal",
  MAX_MSG: 16384,
};

const TOKEN_MIN = 8;
const TOKEN_MAX = 64;

function emptySeat() {
  return { kind: "empty", online: false, token: null, art: null, again: false, offAt: null };
}

// 契約的欄位:phase / wake / seats[i].kind / state / log。其餘是內部的。
//   actAt    這一手的計時起點(換人、電腦接手、真人拿回座位都重算)
//   emptyAt  最後一個在線的真人離開的時間(有人在線時是 null)
export function create(code) {
  return {
    code,
    phase: "waiting",
    seats: [emptySeat(), emptySeat()],
    state: null,
    log: { seed: null, art: [null, null], actions: [] },
    last: null,
    wake: null,
    actAt: null,
    emptyAt: null,
  };
}

// ───────────────────────────── 送出去的訊息 ─────────────────────────────

// 輪到真人才有期限;電腦的座位沒有(它照 BOT_DELAY_MS 走)。
function deadlineOf(r) {
  if (r.phase !== "playing") return null;
  return r.seats[r.state.turn].kind === "human" ? r.actAt + ROOM.TURN_MS : null;
}

// `now` 是這一次 `step` 收到的時間,不是這件事「排定」發生的時間:alarm 遲到 300 毫秒的
// 時候,客戶端該看到的剩餘時間也短 300 毫秒。`deadline` 和 `now` 同一支時鐘,所以倒數要用
// `deadline − now` 算,再用客戶端自己的時鐘往下數——不能拿客戶端的時鐘去減 `deadline`
// (orchestrator 線上實測:他的機器把 30 秒的期限讀成 26.7 秒)。
function stateMsg(r, seat, now) {
  return {
    t: "state",
    code: r.code,
    seat,
    phase: r.phase,
    seats: r.seats.map((s) => ({ kind: s.kind, online: s.online })),
    view: r.state ? view(r.state, seat) : null, // waiting 時是 null
    now,
    deadline: deadlineOf(r),
    last: r.last ? clone(r.last) : null,
    again: [r.seats[0].again, r.seats[1].again],
  };
}

// 任何變化都送給每一個在線的真人座位,各自帶自己的 seat。
// 收不收得到看的是「這個座位有沒有活著的連線」,不是 kind:座位被電腦接手的那一刻,
// 正是那個人最需要看到畫面的時候(本來 kind === "bot" 就蘊含 !online,兩種寫法在正常
// 情況下一模一樣;差別只在有人把 kind 寫錯的時候,他會看到,而不是安靜地被斷掉)。
function broadcast(r, out, now) {
  for (let i = 0; i < 2; i++) {
    const s = r.seats[i];
    if (s.online && typeof s.token === "string") out.push({ to: s.token, msg: stateMsg(r, i, now) });
  }
}

// ───────────────────────────── 會自己發生的事 ─────────────────────────────

// 下一件會自己發生的事,沒有就 null。排程(room.wake)和執行(advance)讀的是同一份。
// 同一毫秒同時到期時,上面的排在前面:先讓電腦接手,再談這一手的期限。
function due(r) {
  const c = [];
  if (r.phase === "playing") {
    for (let i = 0; i < 2; i++) {
      const s = r.seats[i];
      // 離線接手只在對局中:等人的房間裡把唯一的人換成電腦沒有意義,結束後換了還會自動答應再來一張。
      if (s.kind === "human" && !s.online && s.offAt !== null) c.push({ at: s.offAt + ROOM.OFFLINE_MS, what: "takeover", seat: i });
    }
    const t = r.state.turn;
    if (r.seats[t].kind === "human") c.push({ at: r.actAt + ROOM.TURN_MS, what: "timeout", seat: t });
    else if (r.seats[t].kind === "bot") c.push({ at: r.actAt + ROOM.BOT_DELAY_MS, what: "botmove", seat: t });
  } else if (r.phase !== "dead" && r.emptyAt !== null) {
    // 對局中不算閒置:兩個人都走了,電腦要先把這一局打完。
    c.push({ at: r.emptyAt + ROOM.IDLE_MS, what: "idle", seat: -1 });
  }
  let best = null;
  for (const x of c) if (!best || x.at < best.at) best = x;
  return best;
}

function sync(r, now) {
  if (r.phase !== "dead") {
    if (r.seats.some((s) => s.kind === "human" && s.online)) r.emptyAt = null;
    else if (r.emptyAt === null) r.emptyAt = now;
  }
  const d = r.phase === "dead" ? null : due(r);
  r.wake = d ? d.at : null;
}

// 代打的種子由 log 決定(seed + 第幾手 + 座位),所以整局重播得出來,而且不碰 rand。
function botSeed(r, seat) {
  return (Math.imul(r.log.seed | 0, 0x9e3779b1) ^ Math.imul(r.log.actions.length + 1, 0x85ebca6b) ^ (seat + 1)) | 0;
}

// 出一手。`apply` 先跑:它 throw 的時候 room 一個欄位都還沒動。
function play(r, seat, action, auto, at) {
  const next = apply(r.state, action);
  r.state = next;
  r.log.actions.push(action);
  r.last = { by: seat, action: { plane: action.plane, ang: action.ang, pr: action.pr }, auto };
  r.actAt = at;
  if (next.over) {
    r.phase = "over";
    r.seats[0].again = false;
    r.seats[1].again = false;
  }
}

// 電腦出一手。auto = true 表示這是逾時代打(座位還是真人的);電腦自己的座位是 false。
// `at` 是這一手排定發生的時間(進 actAt,期限才不會跟著遲到的 tick 一起漂);`now` 只進訊息。
function botPlay(r, seat, at, auto, out, now) {
  try {
    const pick = choose(view(r.state, seat), seat, ROOM.BOT_LEVEL, botSeed(r, seat));
    play(r, seat, { type: "fire", plane: pick.plane, ang: pick.ang, pr: pick.pr }, auto, at);
  } catch (e) {
    // 引擎的不變式說輪到的人一定有活著的飛機,所以走不到這裡。真的走到了,把時鐘推一格
    // 讓房間繼續活著(還有閒置刪除接手),不要讓整個 DO 炸掉。
    r.actAt = at;
    return;
  }
  broadcast(r, out, now);
}

function act(r, d, out, now) {
  if (d.what === "takeover") {
    const s = r.seats[d.seat];
    s.kind = "bot"; // s.token 留著:同一個分頁回來,hello 就拿回座位
    s.offAt = null;
    if (r.state.turn === d.seat) r.actAt = d.at; // 電腦從接手的那一刻開始想
    broadcast(r, out, now);
  } else if (d.what === "timeout") {
    botPlay(r, d.seat, d.at, true, out, now);
  } else if (d.what === "botmove") {
    botPlay(r, d.seat, d.at, false, out, now);
  } else if (d.what === "idle") {
    r.phase = "dead";
    broadcast(r, out, now);
  }
}

// 把房間走到 now:每一件到期的事都做,不管中間有沒有人來 tick(alarm 遲到、hibernate 醒來
// 之後補做,結果都一樣)。每一件事都會把下一次的時間往後推,所以這個迴圈會停。
function advance(r, now, out) {
  for (let guard = 0; guard < 4096; guard++) {
    sync(r, now);
    const d = due(r);
    if (!d || d.at > now) break;
    act(r, d, out, now);
  }
  sync(r, now);
}

// ───────────────────────────── 事件 ─────────────────────────────

function seatOf(r, token) {
  if (typeof token !== "string") return -1;
  return r.seats.findIndex((s) => s.kind === "human" && s.token === token);
}

// 畫是對方送來的資料:交給引擎驗,錯的整個 hello 失敗(不夾、不截斷)。
function artOk(art) {
  if (art === null) return true;
  try {
    setup(0, { art: [art, null] });
    return true;
  } catch (e) {
    return false;
  }
}

// 開新的一局。畫從座位讀,所以「再來一張」自動留著上一局的畫。
// 誰先手由種子決定(owner 裁決 #4 / #10):不傳 opts.first,也就跟 replay 走同一條路。
function start(r, seed32, now) {
  const seed = seed32 | 0;
  const art = [r.seats[0].art, r.seats[1].art];
  r.state = setup(seed, { art });
  r.log = { seed, art, actions: [] };
  r.phase = "playing";
  r.last = null;
  r.actAt = now;
  r.seats[0].again = false;
  r.seats[1].again = false;
}

function hello(r, ev, now, rand, out) {
  const token = ev.token;
  if (typeof token !== "string" || token.length < TOKEN_MIN || token.length > TOKEN_MAX) return "bad_hello";
  const art = ev.art === undefined ? null : ev.art;
  if (!artOk(art)) return "bad_art";

  const back = r.seats.findIndex((s) => s.kind !== "empty" && s.token === token);
  if (back >= 0) {
    const s = r.seats[back];
    const wasBot = s.kind === "bot";
    s.kind = "human";
    s.online = true;
    s.offAt = null;
    if (r.phase === "waiting") s.art = art; // 還沒開局,畫可以再換
    if (wasBot && r.phase === "playing" && r.state.turn === back) r.actAt = now; // 拿回座位,重新給 30 秒
    broadcast(r, out, now);
    return null;
  }

  const free = r.seats.findIndex((s) => s.kind === "empty");
  if (free < 0) return "full";
  r.seats[free] = { kind: "human", online: true, token, art, again: false, offAt: null };
  if (r.phase === "waiting" && r.seats[0].kind !== "empty" && r.seats[1].kind !== "empty") start(r, rand(), now);
  broadcast(r, out, now);
  return null;
}

function fire(r, ev, now, out) {
  const seat = seatOf(r, ev.token);
  if (seat < 0 || r.phase !== "playing") return "bad_state";
  if (r.state.turn !== seat) return "not_your_turn";
  // 只抄這三個欄位:客戶端送來的其他東西不進 state,也不進 log。
  const action = { type: "fire", plane: ev.plane, ang: ev.ang, pr: ev.pr };
  try {
    play(r, seat, action, false, now);
  } catch (e) {
    return "bad_move";
  }
  broadcast(r, out, now);
  return null;
}

function seatBot(r, ev, now, rand, out) {
  const seat = seatOf(r, ev.token);
  if (seat < 0 || r.phase !== "waiting") return "bad_state";
  const other = 1 - seat;
  if (r.seats[other].kind !== "empty") return "bad_state";
  r.seats[other] = { kind: "bot", online: false, token: null, art: null, again: false, offAt: null };
  start(r, rand(), now);
  broadcast(r, out, now);
  return null;
}

function again(r, ev, now, rand, out) {
  const seat = seatOf(r, ev.token);
  if (seat < 0 || r.phase !== "over") return "bad_state";
  r.seats[seat].again = true;
  if (r.seats.every((s) => s.kind === "bot" || s.again)) start(r, rand(), now); // 電腦的座位自動同意
  broadcast(r, out, now);
  return null;
}

function drop(r, ev, now, out) {
  const seat = seatOf(r, ev.token);
  if (seat < 0) return null; // 不認得的 token 斷線:那條連線已經關了,回錯誤也送不到
  const s = r.seats[seat];
  if (!s.online && s.offAt !== null) return null;
  s.online = false;
  s.offAt = now;
  broadcast(r, out, now);
  return null;
}

// 回傳 error code(房間不變)或 null。
function handle(r, ev, now, rand, out) {
  if (!ev || typeof ev !== "object") return "bad_state";
  if (ev.type === "tick") return null; // advance 已經把到期的事做完了
  if (r.phase === "dead") return ev.type === "drop" ? null : "bad_state";
  switch (ev.type) {
    case "hello":
      return hello(r, ev, now, rand, out);
    case "fire":
      return fire(r, ev, now, out);
    case "bot":
      return seatBot(r, ev, now, rand, out);
    case "again":
      return again(r, ev, now, rand, out);
    case "drop":
      return drop(r, ev, now, out);
    default:
      return "bad_state";
  }
}

export function step(room, ev, now, rand) {
  const r = clone(room);
  const out = [];
  advance(r, now, out);
  const code = handle(r, ev, now, rand, out);
  if (code !== null) {
    // 錯的事件 → 房間一個位元組都不變(連 advance 的結果一起丟掉:wake 沒動,DO 的 alarm
    // 還在原來的時間,到期的事下一次還是會做)。只回一則 error 給出錯的那個 token。
    return { room: clone(room), out: [{ to: ev && ev.token, msg: { t: "error", code } }] };
  }
  sync(r, now);
  return { room: r, out };
}
