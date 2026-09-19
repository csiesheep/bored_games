// 紙上空戰的引擎:純函式,瀏覽器(單人、對坐)和房間共用。
//
// M1:開局、合法的手、出一手、出手上限、送給座位看的 view、種子重播。
// 這份是起手的 session 寫的,沒有經過獨立驗證:在這裡找到缺陷,先假設是它錯。
//
// 數值的出處是規則筆記(vault: Projects/bored_games/bored_games - rulebook.md)。
// 改數值要 orchestrator 裁決;tests/acceptance.js 有一份獨立抄寫的對照。

export const RULES = {
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

// JSON clone,不用 structuredClone(這台機器上 V8 會當)。
export function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// mulberry32,狀態放在 state.rng,所以「種子 + 動作」可以重播同一局。
function rand(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function setup(seed) {
  const state = {
    seed: seed | 0,
    rng: seed | 0,
    turn: 0,
    shots: [0, 0],
    planes: [],
    inks: [],
    over: false,
    winner: null,
  };
  for (let side = 0; side < 2; side++) {
    for (let k = 0; k < RULES.PLANES; k++) {
      const x = RULES.SLOT_X[k] + (rand(state) * 2 - 1) * RULES.SLOT_JITTER;
      const d = RULES.START_MIN + rand(state) * (RULES.START_MAX - RULES.START_MIN);
      state.planes.push({
        id: side * RULES.PLANES + k,
        side,
        x,
        y: side === 0 ? RULES.H - d : d,
        ang: side === 0 ? -Math.PI / 2 : Math.PI / 2,
        alive: true,
        by: null,
        lost: false,
      });
    }
  }
  return state;
}

// 這個座位現在能出的手:自己每架活著的飛機各一種,方向任意、力道 0 到 1。
export function legal(state, seat) {
  if (state.over || seat !== state.turn) return [];
  return state.planes
    .filter((p) => p.side === seat && p.alive)
    .map((p) => ({ type: "fire", plane: p.id, ang: [-Math.PI, Math.PI], pr: [0, 1] }));
}

// 一條線的取樣點。lenErr 是長度倍率,curv 是側向弧度係數;兩個都由引擎的亂數決定。
export function trace(x, y, ang, pr, lenErr, curv) {
  const len = (RULES.MIN_LEN + (RULES.MAX_LEN - RULES.MIN_LEN) * pr) * lenErr;
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  const pts = [];
  for (let i = 0; i <= RULES.SAMPLES; i++) {
    const s = i / RULES.SAMPLES;
    const f = s * len;
    const l = curv * len * s * s;
    pts.push({ x: x + dx * f - dy * l, y: y + dy * f + dx * l });
  }
  return pts;
}

// 紙邊算在紙上(規則筆記未知數 #7:x ∈ [0, 600]、y ∈ [0, 900] 含邊)。
// NaN 的比較一律 false,所以壞掉的座標自動算出界。判定出界只走這一個函式。
export function onPaper(p) {
  return p.x >= 0 && p.x <= RULES.W && p.y >= 0 && p.y <= RULES.H;
}

export function apply(prev, action) {
  if (prev.over) throw new Error("game is over");
  if (!action || action.type !== "fire") throw new Error("unknown action");
  const { plane, ang, pr } = action;
  if (!Number.isFinite(ang) || !Number.isFinite(pr) || pr < 0 || pr > 1) throw new Error("bad ang or pr");
  const state = clone(prev);
  const me = state.planes.find((p) => p.id === plane);
  if (!me || me.side !== state.turn || !me.alive) throw new Error("not your plane");

  const lenErr = 1 + (rand(state) * 2 - 1) * RULES.LEN_ERR;
  const curv = (rand(state) * 2 - 1) * RULES.CURVE;
  const pts = trace(me.x, me.y, ang, pr, lenErr, curv);

  for (const q of pts) {
    for (const o of state.planes) {
      if (!o.alive || o.side === me.side) continue;
      const d = Math.hypot(o.x - q.x, o.y - q.y);
      if (d < RULES.HIT) {
        o.alive = false;
        o.by = me.side;
      }
    }
  }

  const end = pts[pts.length - 1];
  const before = pts[pts.length - 2];
  me.x = end.x;
  me.y = end.y;
  me.ang = Math.atan2(end.y - before.y, end.x - before.x);
  if (!onPaper(me)) {
    me.alive = false;
    me.lost = true;
  }

  state.inks.push({ side: me.side, pts });
  state.shots[me.side]++;

  // 結束條件的順序(規則筆記「先打光對方的人贏」;數量都是算完這一手的戰果之後的)。
  //   1 對方沒飛機了 → 出手的人贏(就算自己同一手也出界、就算這是最後一手)
  //   2 否則自己沒飛機了 → 對方贏
  //   3 否則兩邊都出滿 MAX_SHOTS → 比剩下的飛機,一樣多平手(over 而 winner 是 null)
  //   4 否則換人
  const left = [0, 1].map((s) => state.planes.filter((p) => p.side === s && p.alive).length);
  const foe = 1 - me.side;
  if (left[foe] === 0) {
    state.over = true;
    state.winner = me.side;
  } else if (left[me.side] === 0) {
    state.over = true;
    state.winner = foe;
  } else if (state.shots[0] >= RULES.MAX_SHOTS && state.shots[1] >= RULES.MAX_SHOTS) {
    // 「兩個人都出滿」才停:座位 0 先手先到 30,那時候座位 1 還欠一手。
    // 只看出手的人到 30 就停,後手會少打一手,而 M2 要量的正是先手優勢。
    state.over = true;
    state.winner = left[0] === left[1] ? null : left[0] > left[1] ? 0 : 1;
  } else {
    state.turn = foe;
  }
  return state;
}

// 送給座位看的一份 state。深拷貝,改它不會動到原本的 state。
// 現在兩個座位看到的一樣;要不要對座位藏 seed / rng 在等 owner 裁決(issue #1),
// 所以藏的位置留成下面那一行,要藏的時候把註解拿掉就好。
export function view(state, seat) {
  const v = clone(state);
  // if (seat !== undefined) { delete v.seed; delete v.rng; }
  return v;
}

// 種子 + 動作序列 → 最後的 state。動作是空的就等於 setup(seed)。
// 中途任何一手不合法就讓 apply 丟出來:不跳過、不截斷,不然重播會安靜地換成另一局。
export function replay(seed, actions) {
  let state = setup(seed);
  for (const a of actions || []) state = apply(state, a);
  return state;
}
