// Cloudflare Worker: path-prefix router in front of the static assets.
//
// `run_worker_first: true` (wrangler.jsonc) sends every request here before
// asset matching, so we can strip the prefix and still serve from
// the bare *.workers.dev root (or `wrangler dev`) while testing.
//
// The public path segment is independent of the repo / Worker name — change
// PREFIX alone to move the site to a different path.
//
// One Worker holds the whole notebook: `/bored_games/` is the cover, each game
// lives in its own folder (`/bored_games/dogfight/`). `/bored_games/ws?room=ABCD`
// upgrades to a room: one Durable Object per room code.

const PREFIX = "/bored_games";

// Four capital letters, minus the two that are easy to misread on paper (I, O).
// The client that opens the room picks the code; the Worker only checks it —
// `idFromName` maps the code to the one Durable Object that holds that room.
const ROOM_CODE = /^[A-HJ-NP-Z]{4}$/;

// The Durable Object class has to be exported from the Worker's entry point
// for the ROOMS binding (wrangler.jsonc) to find it.
export { Room } from "./room.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === PREFIX) {
      url.pathname = PREFIX + "/";
      return Response.redirect(url.toString(), 301);
    }

    if (!url.pathname.startsWith(PREFIX + "/")) {
      return new Response("Not found", { status: 404 });
    }

    if (url.pathname === PREFIX + "/ws") {
      // The code is checked before the upgrade, so a bad code is always a 400
      // whether or not the caller asked to upgrade. Strict: not upper-cased,
      // not trimmed — two players who typed `abcd` and `ABCD` must not land in
      // two rooms that look like one name. Normalising is the page's job.
      const code = url.searchParams.get("room") || "";
      if (!ROOM_CODE.test(code)) return new Response("bad room code", { status: 400 });
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected a websocket upgrade", { status: 426 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
    }

    url.pathname = url.pathname.slice(PREFIX.length);
    const response = await env.ASSETS.fetch(new Request(url, request));

    // The static-asset handler builds Location from the url we just stripped
    // the prefix off, so a same-origin redirect would escape this Worker and
    // 404 on the hub. Put the prefix back on.
    const location = response.headers.get("location");
    if (location) {
      const target = new URL(location, url);
      if (
        target.origin === url.origin &&
        target.pathname !== PREFIX &&
        !target.pathname.startsWith(PREFIX + "/")
      ) {
        target.pathname = PREFIX + target.pathname;
        const headers = new Headers(response.headers);
        headers.set("location", target.toString());
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    }
    return response;
  },
};
