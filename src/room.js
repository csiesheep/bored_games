// 一個房間一個 Durable Object。這一層只有接線,沒有規則。
//
// 規則全部在 src/room-core.js(純函式,驗收第 17 組釘住)。這裡做的事只有四件:
//   1. WebSocket 進來 / 訊息 / 關掉 → 轉成核心的事件
//   2. `Date.now()` 和 `crypto.getRandomValues` → 餵給核心(只有這一層碰時鐘和亂數)
//   3. `step` 回來的 `out` → 送到對應 token 的連線;`room` → storage;`room.wake` → alarm
//   4. `alarm()` → `tick`;`phase === "dead"` → 把自己刪掉
//
// 對方送來的東西一律不信任:大小在 JSON.parse 之前就擋掉;`token` 記在連線上
// (`serializeAttachment`),訊息裡自己帶的 token 除了第一則 hello 以外一概不看——
// 不然任何人都可以拿別人的 token 出手。
//
// 客戶端送的訊息(FE 照這個寫):
//   {t:"hello", token, art}   第一則一定是它;token 是客戶端自己產生的 8–64 字元字串,
//                             存在 sessionStorage / localStorage 裡,重連時拿回座位。
//                             art 是三張畫或 null。
//   {t:"fire", plane, ang, pr}
//   {t:"bot"}                 等不到人,讓班長頂上
//   {t:"again"}               再撕一張
// 其他的 `t`、不是 JSON、不是文字訊息、超過 ROOM.MAX_MSG 位元組 → 直接關掉連線。
//
// 伺服器送的訊息:{t:"state", …} 和 {t:"error", code}(形狀見 room-core.js)。
//
// WebSocket Hibernation:連線閒著的時候這個 DO 可以被收掉,醒來時 constructor 會重跑,
// 房間從 storage 讀回來。所以「現在幾點」永遠來自 `Date.now()`,不留在記憶體裡。

import { ROOM, create, step } from "./room-core.js";

const KEY = "room"; // storage 只有這一個 key

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    this.code = ""; // 這一次醒著的期間看到的房間碼(房間本身存的那份才是準的)
    // 先把房間讀回來再處理任何事件(hibernate 醒來、alarm 觸發都會走到這裡)
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get(KEY)) || null;
    });
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a websocket upgrade", { status: 426 });
    this.code = new URL(request.url).searchParams.get("room") || "";
    if (!this.room) this.room = create(this.code); // 還沒有人 hello,先不寫 storage
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, data) {
    const att = ws.deserializeAttachment();
    const token = att && att.token;

    // 大小在 parse 之前先擋。字元數一定 ≤ 位元組數,所以先用便宜的那個篩掉大的。
    if (typeof data !== "string") return this.kill(ws, 1003, "text only");
    if (data.length > ROOM.MAX_MSG) return this.kill(ws, 1009, "too big");
    if (new TextEncoder().encode(data).byteLength > ROOM.MAX_MSG) return this.kill(ws, 1009, "too big");

    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      return this.kill(ws, 1008, "bad json");
    }
    if (!msg || typeof msg !== "object") return this.kill(ws, 1008, "bad json");

    const art = msg.art === undefined ? null : msg.art;
    let ev;
    if (!token) {
      // 第一則必須是 hello;token 只有這一次從訊息裡拿(核心會驗 8–64 字元)
      if (msg.t !== "hello") return this.kill(ws, 1008, "hello first");
      ev = { type: "hello", token: msg.token, art };
    } else {
      switch (msg.t) {
        case "hello":
          ev = { type: "hello", token, art };
          break;
        case "fire":
          ev = { type: "fire", token, plane: msg.plane, ang: msg.ang, pr: msg.pr };
          break;
        case "bot":
          ev = { type: "bot", token };
          break;
        case "again":
          ev = { type: "again", token };
          break;
        default:
          return this.kill(ws, 1008, "unknown t");
      }
    }

    if (!this.room) this.room = create(this.code); // 理論上 fetch 已經建好了
    const out = await this.run(ev, ws, ev.token);
    if (!token) {
      // 第一則 hello:被拒絕就關掉(錯誤上面已經送出去了),收下才把 token 綁在連線上
      if (out.some((o) => o.msg.t === "error")) this.kill(ws, 1008, "hello refused");
      else ws.serializeAttachment({ token: ev.token });
    }
  }

  async webSocketClose(ws) {
    await this.gone(ws);
  }

  async webSocketError(ws) {
    await this.gone(ws);
  }

  async alarm() {
    if (!this.room) this.room = (await this.ctx.storage.get(KEY)) || null;
    if (!this.room) return;
    await this.run({ type: "tick" }, null, null);
  }

  // ── 接線 ──────────────────────────────────────────────────────────────

  async gone(ws) {
    const att = ws.deserializeAttachment();
    if (!att || !att.token || !this.room) return;
    // 重新整理的時候新舊連線會短暫並存:同一個 token 還有別條線活著就不算斷線。
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const a = other.deserializeAttachment();
      if (a && a.token === att.token) return;
    }
    await this.run({ type: "drop", token: att.token }, null, null);
  }

  // 只有這裡碰時鐘和亂數。
  async run(ev, from, fromToken) {
    const res = step(this.room, ev, Date.now(), () => crypto.getRandomValues(new Uint32Array(1))[0]);
    this.room = res.room;

    if (this.room.phase === "dead") {
      this.send(res.out, from, fromToken);
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.room = null;
      for (const ws of this.ctx.getWebSockets()) this.kill(ws, 1001, "room closed");
      return res.out;
    }

    await this.ctx.storage.put(KEY, this.room);
    if (typeof this.room.wake === "number") await this.ctx.storage.setAlarm(this.room.wake);
    else await this.ctx.storage.deleteAlarm();
    this.send(res.out, from, fromToken);
    return res.out;
  }

  // out 的每一則送到「掛著那個 token」的連線。第一則 hello 被拒絕時連線上還沒有 token,
  // 那一則錯誤要走 from 這條路,不然那個人只會看到連線莫名其妙斷掉。
  send(out, from, fromToken) {
    for (const o of out) {
      const text = JSON.stringify(o.msg);
      let sent = false;
      for (const ws of this.ctx.getWebSockets()) {
        const a = ws.deserializeAttachment();
        if (a && a.token === o.to) {
          try {
            ws.send(text);
          } catch (e) {
            /* 已經關了 */
          }
          sent = true;
        }
      }
      if (!sent && from && o.to === fromToken) {
        try {
          from.send(text);
        } catch (e) {
          /* 已經關了 */
        }
      }
    }
  }

  kill(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch (e) {
      /* 已經關了 */
    }
  }
}
