// 連線模式的前端零件:房間碼、token、倒數、網址、一條 WebSocket。
//
// 這個檔案的上半部是**純函式**(驗收第 19 組釘住):不碰 DOM、不碰 WebSocket、不碰時鐘,
// 亂數從外面給(`rand()` 回 0 到 1)。下半部 `Conn` 才是接線,而且它也不碰 DOM——
// 它只會 new 一條 WebSocket、把收到的訊息原樣交出去。
//
// 三條不可協商的線(orchestrator 裁決 #14):
//   1. 連線模式裡**伺服器是唯一的真相**。這裡不 setup、不 apply、不判斷命中 / 換人 / 結束。
//      這個檔案連 engine.js 都不 import——沒有規則可以偷偷長在這裡。
//   2. 倒數只能用 `remainingMs`(伺服器的 `now`),不可以拿 `deadline` 減本機的 `Date.now()`。
//      客戶端的時鐘跟伺服器差幾秒是常態(#12 線上實測差了 3311 毫秒,30 秒的期限被讀成 26.7 秒)。
//   3. WebSocket 的網址從**頁面所在的位置**推(`…/dogfight/` → `…/ws?room=碼`,`https` → `wss`),
//      不寫死網域:同一份檔案要能在 `wrangler dev` 的本機 Worker 和線上都連得到。
//
// 同一局只開一條連線:`Conn` 自己保證這件事(開新的之前先把舊的關乾淨)。

// 四個大寫字母,去掉紙上容易看錯的 I 和 O。伺服器那一端是 `/^[A-HJ-NP-Z]{4}$/`
// (`src/index.js`),兩邊講的是同一件事:這裡是產生器,那裡是守門員。
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

// ⚠ 這是 `ROOM.OFFLINE_MS`(`src/room-core.js`)的第二份。`public/` 在瀏覽器裡讀不到 `src/`,
// 而 `state` 訊息沒有帶「對方還剩幾秒被接手」。只用來顯示 `net.oppOffline` 的倒數,不影響
// 任何行為——但兩份數字不一樣的時候,畫面會在一個不存在的時間點說「電腦要接手了」。
// 所以它是 export 的:驗收拿它去對 `ROOM.OFFLINE_MS`,伺服器那邊一改這裡就紅
// (orchestrator 裁決 #14,退回的那一則留言)。
export const OFFLINE_MS = 20000;

const TOKEN_KEY_PREFIX = "bg.dogfight.token.";

// ───────────────────────────── 純函式 ─────────────────────────────

// 開房間的人自己隨機一個碼。`rand()` 回 0 到 1。
export function genCode(rand) {
  const n = CODE_ALPHABET.length;
  let s = "";
  for (let i = 0; i < 4; i++) {
    const k = Math.floor(rand() * n);
    s += CODE_ALPHABET[k < 0 ? 0 : k >= n ? n - 1 : k];
  }
  return s;
}

// 玩家打進來的東西 → 房間碼,或 null。空白隨便打、小寫都收;I 和 O 不收(它們不在字母表裡,
// 猜玩家想打 1 還是 l 只會把兩個人送進兩個不同的房間)。
export function normCode(input) {
  if (typeof input !== "string") return null;
  const s = input.replace(/\s+/g, "").toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

// 認座位用的 token。客戶端自己產生,伺服器只拿它比對(#12)。8 到 64 個字元。
export function newToken(rand) {
  let s = "";
  for (let i = 0; i < 4; i++) s += Math.floor(rand() * 4294967296).toString(36).padStart(7, "0");
  return s.slice(0, 32);
}

// 這一手還剩幾毫秒。**只看伺服器的兩個數字相減**,本機的時鐘只用來量「收到之後過了多久」
// (兩次本機時間相減,時鐘偏移在這一減裡自己消掉)。沒有期限回 null,到期了回 0、不會是負的。
export function remainingMs(msg, recvAt, now) {
  if (!msg || typeof msg.deadline !== "number" || typeof msg.now !== "number") return null;
  const left = msg.deadline - msg.now - (now - recvAt);
  return left > 0 ? left : 0;
}

// 毫秒 → m:ss(等人等了多久)。
export function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// 頁面在 `…/<前綴>/dogfight/`(或它底下的某一頁)→ WebSocket 在 `…/<前綴>/ws?room=碼`。
// 網域、路徑前綴、http/https 全部從 `loc` 推:本機的 `wrangler dev`(沒有前綴)、線上的
// `/bored_games/` 都走同一條路。
export function wsUrl(loc, code) {
  const dir = String(loc.pathname).replace(/[^/]*$/, ""); // …/dogfight/
  const base = dir.replace(/[^/]*\/$/, ""); // …/
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + loc.host + base + "ws?room=" + code;
}

// 要分享出去的那個連結:同一頁,帶著 `?room=碼`(和玩家挑明了的語言)。
export function roomUrl(loc, code, lang) {
  const u = new URL(loc.href);
  u.hash = "";
  u.search = "";
  u.searchParams.set("room", code);
  if (lang) u.searchParams.set("lang", lang);
  return u.href;
}

// sessionStorage 的 key:一個房間碼一個。同一個分頁重新整理 = 同一個人(拿回座位),
// 另一個分頁 = 另一個人(sessionStorage 不跨分頁)。
export function tokenKey(code) {
  return TOKEN_KEY_PREFIX + code;
}

// 這個分頁在這個房間**已經有**的 token,沒有就 null。
// 「有」等於「這個分頁進過這個房間」——回來的人靠它認出自己,不用再畫一次飛機。
// sessionStorage 被擋掉(無痕、被關掉)也回 null:那種分頁每次都是新的人,只能重畫。
export function savedToken(code, store) {
  try {
    const s = store.getItem(tokenKey(code));
    return typeof s === "string" && s.length >= 8 && s.length <= 64 ? s : null;
  } catch (_) {
    return null;
  }
}

// 這個分頁在這個房間的 token:有就拿舊的,沒有就產生一個存起來。
export function tokenFor(code, rand, store) {
  const back = savedToken(code, store);
  if (back) return back;
  const t = newToken(rand);
  try {
    store.setItem(tokenKey(code), t);
  } catch (_) {}
  return t;
}

// ───────────────────────────── 一條連線 ─────────────────────────────
// 退避 1、2、4、8 秒,之後每 8 秒。收到伺服器的 state 才算「真的連上了」,退避歸零。
export const BACKOFF_MS = [1000, 2000, 4000, 8000];

// 同一局只開一條連線。`start()` 可以重複叫(重連走的就是它),它一定先把舊的關乾淨。
// 這個 class 不碰 DOM:收到什麼、斷了、連上了,一律回呼出去,畫面的事留給 app.js。
export class Conn {
  //   url()      回傳這一次要連的網址(從頁面位置推,所以交給呼叫的人給)
  //   hello()    每一次連上要送的第一則訊息(重連用同一個 token)
  //   onMsg(msg, recvAt)  收到伺服器的訊息(已經 JSON.parse);recvAt 是本機的 Date.now()
  //   onUp() / onDown()   連上了 / 斷了(斷了就會自動重連,除非 stop())
  constructor(o) {
    this.o = o;
    this.ws = null;
    this.timer = null;
    this.tries = 0;
    this.stopped = false;
    this.up = false;
  }

  start() {
    if (this.stopped) return;
    this.clearTimer();
    this.drop(); // 開新的之前一定先關乾淨:不然重連會留下一條殭屍連線,伺服器那邊還當你在線
    let ws;
    try {
      ws = new WebSocket(this.o.url());
    } catch (_) {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      try {
        ws.send(JSON.stringify(this.o.hello()));
      } catch (_) {}
    });
    ws.addEventListener("message", (e) => {
      if (this.ws !== ws) return;
      let msg = null;
      try {
        msg = JSON.parse(e.data);
      } catch (_) {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (!this.up) {
        this.up = true;
        this.tries = 0;
        if (this.o.onUp) this.o.onUp();
      }
      this.o.onMsg(msg, Date.now());
    });
    const gone = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const wasUp = this.up;
      this.up = false;
      if (this.stopped) return;
      if (this.o.onDown) this.o.onDown(wasUp);
      this.retry();
    };
    ws.addEventListener("close", gone);
    ws.addEventListener("error", gone);
  }

  send(msg) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (_) {
      return false;
    }
  }

  // 退避:1、2、4、8 秒,之後每 8 秒。
  retry() {
    if (this.stopped || this.timer !== null) return;
    const wait = BACKOFF_MS[Math.min(this.tries, BACKOFF_MS.length - 1)];
    this.tries++;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, wait);
  }

  clearTimer() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  drop() {
    const ws = this.ws;
    this.ws = null;
    this.up = false;
    if (!ws) return;
    try {
      ws.close();
    } catch (_) {}
  }

  // 這一局不玩了(房間滿了、離開頁面)。之後不再重連。
  stop() {
    this.stopped = true;
    this.clearTimer();
    this.drop();
  }
}
