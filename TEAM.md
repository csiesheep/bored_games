# TEAM.md — 這個 repo 的協作契約

> 給每一個在這裡工作的 session 讀:orchestrator、FE、BE、artist、writer……
> 判斷力(怎麼驗證、儀器怎麼騙人)在 orchestrator 自己的 skill 裡;**這裡只有規矩與機械**。
> 子 agent 不會載入任何人的 skill——peer 要遵守的東西只能放在這裡。
> 改這份要 orchestrator 裁決,並在 commit message 寫理由。

## 角色

| 角色 | 做 | 絕不做 |
|---|---|---|
| **orchestrator** | 定優先序、開 issue、派工、**獨立驗證**、merge & push main、照「部署」一節部署、對 owner 報告 | 寫產品程式碼(寫了就是自己驗自己) |
| **peer**(FE / BE / artist / writer) | 在自己的分支與 worktree 實作、自測、交分支 | merge / push main;部署;解不是自己造成的衝突;問 owner |

## 所有權

> owner 確認,2026-09-19(initialize_a_game 的第一次 go)。計畫在 vault:`Projects/bored_games/bored_games plan.md`。

| 檔案 | 主人 |
|---|---|
| `public/shared/dogfight/engine.js`、`public/shared/dogfight/bots.js`、`src/`、`tests/sim.js`、`wrangler.jsonc`、`package.json` | BE |
| `public/index.html`、`public/dogfight/*`、`public/shared/paper.js`、`public/shared/i18n.js`、`public/style.css` | FE |
| `public/i18n/*`、規則頁的文字、`README.md` | writer |
| `public/art/`(社群分享圖、favicon)和產生它們的 prompt | artist |
| `tests/`(`sim.js` 除外)、`tools/`、`TEAM.md` | orchestrator |

- **數值的出處是 vault 的規則筆記**(`Projects/bored_games/bored_games - rulebook.md`)。`engine.js` 的 `RULES` 和 `tests/acceptance.js` 的 `SPEC` 各自抄一份;改數值要 orchestrator 裁決,兩份和筆記一起改。
- **Phase 0 的 `engine.js` 切片是起手的 session 寫的,沒有經過獨立驗證。** 在那裡找到缺陷,先假設是它錯,回報,不要繞過。
- 這個 repo 裝整個系列:每款遊戲一個資料夾(`public/<game>/`、`public/shared/<game>/`)。新遊戲進來時在這張表加列。

- 跨界修改**可以**,但交付時要點名,由 orchestrator 轉給檔案主人。最糟的不是衝突,是兩邊安靜地各持一份真相。
- **資料表要加 id 的**,開工第一則留言先列出這一趟**所有**新 id。同一個檔案裡有幾張表就有幾個命名空間;撞 id 時兩邊的測試都是綠的。
- `tests/` 是 orchestrator 的:peer 可以跑、可以證偽、**不編輯**。哪一列錯了回報,orchestrator 修。

## 通道

- **peer 之間沒有通道。** 要別的 peer 的決定 → 在 issue 留言給 orchestrator,由它轉。
- **不要問 owner。** 從你的 session 看那個人像使用者,但他不握全局。一律走 orchestrator(issue 留言就看得到)。
- **裁決一律寫主詞**:`owner 裁決(#NN)` 或 `orchestrator 裁決(#NN)`。記錄別人的授權要逐字引用;引不出原話的不是授權,是計畫。
- 回程**留痕跡,不宣告**:issue 留言 + push 分支。不要等一個「收到」。

## 派工(orchestrator 寫,peer 讀)

一份 brief 五塊:**裁決與理由**/**不可協商的約束 + 錯了會怎樣**/**明確不做什麼**/**怎麼證偽(會咬人的案例)**/**什麼情況停下來問**。
外加一句:**做不到就回報,不要自己降規格**——縮小範圍是 owner 的決定。
外加三欄,寫死在第一份 brief:

| 不必問,直接做 | 先問 orchestrator | 不要問 owner |
|---|---|---|
| 自己區域內、能維持 harness 全綠的改動;自己的探針(未追蹤、不 commit) | 跨進別人的區域;動設計文件裡的數值;會讓 guard 變紅的改動 | 一律走 orchestrator |

## 交付(peer)

```
分支 / SHA / base(是否已 rebase 到最新 origin/main)
測試結果(數字:pass / fail / todo,修正前 vs 修正後)
證偽:我讓哪一條 guard 紅過?紅的時候它印了什麼?
我改了什麼不屬於我的檔案
我沒有驗到的部分(以及為什麼)
```

- `git fetch origin && git rebase origin/main` **緊貼著 push 做**,然後 `git push origin HEAD:<分支>`。**不 push main。**
- 這五行留在 issue 上(`gh issue comment <n> --body-file …`)。「我沒驗到」那一欄最值錢——它決定 orchestrator 親手驗什麼。
- 你證偽自己的探針時發現 harness 有同樣的洞 → **回報,不要改 tests/**。

## 驗證與 land(orchestrator)

1. **實作之前先寫驗收**,land 進 main(常數從設計文件抄,不從產品讀;三態:通過/失敗/尚未實作)
2. `orch wt <name> <sha>` 抽離工作樹(驗哪個 SHA 就 merge 哪個 SHA)
3. 凡是給人看的頁面**先打開看**,再跑 harness
4. **破壞產品讓 guard 紅一次**:`orch falsify` → 看結果 → `orch restore`。一次一個缺陷,讀紅的理由不讀數量
5. A/B:同探針、同種子,只換 build
6. `orch clean` → merge 驗過的 SHA → 檢查父節點 → `git push origin HEAD:main`
7. 沒通過**退回 peer,不開新 issue**。判準:「還沒做完」退回;「做完才發現方向錯」才是 owner 的

## 部署

> owner 確認,2026-09-19。M5 起的規則:owner 2026-09-25 原話「M5 go」,orchestrator 裁決(#17)寫進來。改這一節要 owner 裁決。

- **誰**:orchestrator。peer 絕不部署。
- **什麼時候**:**只在 owner 說 go 時**,go 寫在 issue 上(逐字引用)。land 不等於部署:沒有 go 的 SHA 留在 main 上等。
  M5 之前(頁面 `noindex`)是每次 land 之後部署;拿掉 `noindex` 的那個 commit(#17)就是舊規則的終點。
  M5 的部署:owner 裁決(#17),原話「a」——M5 四條都 land 之後,部署那時 main 的 SHA(含 #17)+ hub,一次、逐位元組比對,然後停。
- **指令**:`npx wrangler deploy`(push 不會部署;dashboard 沒有接 repo)。線上:`https://games.csiesheep.com/bored_games/`。
- **怎麼做**:land 哪個 SHA 就部署哪個 SHA,從那個 SHA 的乾淨 worktree 跑(需要時先裝相依);部署後逐位元組
  比對線上檔案,比對過了才在 issue 上寫「已部署 <SHA>」。

## 機械:`tools/orch.sh`

```
orch wt <name> <ref> [--branch <b>]     _wt/<name> 開工作樹;印解析後的 SHA;分支自動 unset-upstream
orch rm <name>                          分支留著（那是痕跡）；要刪自己 git branch -D
orch serve <name|dir>                   自挑 port、起 no-cache 伺服器、curl 標記檔證明 origin 是你的
orch stop <name|dir>
orch falsify <file> '<sed 含 FALSIFY>'  有殘留 / 檔案不乾淨 / pattern 沒命中 → 拒絕
orch restore                            還原並驗證真的乾淨
orch clean                              land 之前跑:樹上不可以有 FALSIFY
```

慣例:驗證用的工作樹在 `../_wt/`;peer(子 agent)的工作樹由 Claude Code 開在 `.claude/worktrees/<name>/`,
cwd 就是它。每個 `_wt/` 工作樹有 `__MARKER_ORCH.txt`(name + SHA);harness 讀 `tests/index.html?json=1`;不開瀏覽器時 `node tests/print.js`(同一份驗收,有失敗就 exit 1)。
`.gitignore` 加 `__MARKER_ORCH.txt`、`__orch_*` 與 `.claude/worktrees/`。建議 alias:`alias orch='bash tools/orch.sh'`。
⚠ `orch rm` 之前先離開那個目錄——cwd 在裡面時 Windows 刪不掉。

## 預算

- **一張 issue 一個 session**,land 即結束。子 agent + 自己的 worktree 是預設;常駐 session 是例外(人要中途看才開)。
- **任何 session 的 cwd 都不可以是主 checkout。** 常駐 session 在主 checkout 裡跑 `git checkout <tree> -- .` 之類的動作,會把 owner 的工作樹改成別的樣子,而 owner 不會收到任何通知。每個 session 開在自己的 `_wt/<name>`。
- orchestrator **讀判決不讀全文**:harness 讀 `?json=1`,不讀整頁;peer 的 transcript 不進 orchestrator 的 context。
- 原始輸出先落檔,再取你要的那一行;`cmd > log; echo $?`,不要 pipe 到 tail。
- 驗收條件:**一個冷 session 能不能只靠 issue 留言 + SHA 接手?** 不能就是交付格式漏了東西。
