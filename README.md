# 無聊遊戲簿 / Bored Games

A notebook of the games we made up as bored kids: one gesture, three minutes a game, no tutorial. Live (placeholder for now) at https://games.csiesheep.com/bored_games/.

1. **紙上空戰 / Paper Dogfight**: two players, one folded sheet of paper. Stand your pen on one of your planes, press down and let it slip; the line it leaves destroys any enemy plane it crosses, and your plane moves to where the line ends. Three planes each. In progress.
2. **車窗跑者 / Window Runner**: your fingers run along the power lines outside the car window and jump the poles. Planned.

These are folk pencil-and-paper games remembered from childhood; names, rules text and drawings here are our own.

## How it works

- One Cloudflare Worker for the whole notebook. `src/index.js` is a path-prefix router (`/bored_games`) in front of the static assets in `public/`. The cover is `public/index.html`; each game has its own folder.
- `public/shared/dogfight/engine.js` is pure and runs in the browser and (later) in the room Durable Object. The RNG lives in the state, so a game replays from seed + actions. The engine takes `{plane, ang, pr}`; charging and aim wobble are front-end feel.
- The numbers come from the rules note in the owner's vault; `tests/acceptance.js` keeps an independent hand copy and checks the product against it.

## Milestones

- M0 scaffold, placeholder, `TEAM.md`, a first guard seen red
- M1 engine + tests
- M2 bots + balance harness
- M3 solo and face-to-face UI, draw your own planes, i18n, rules page
- M4 rooms
- M5 ship

## Develop

```bash
npm install
npm test                 # acceptance must have no failing row
node tests/print.js --passes
npx wrangler dev --port 8788
```

Team rules are in `TEAM.md`; mechanics in `tools/orch.sh`.
