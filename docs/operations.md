# 运维手册

合并引擎跑在 Mini 上。一共三样东西：

| 东西 | 在哪 | 作用 |
|---|---|---|
| 运行目录 | `~/praise-merge-runtime/`（不在 Syncthing 同步目录里） | 代码 + 真实配置 `config/app.json`、`config/policy.json` |
| 状态目录 | `~/.local/state/praise-merge/` | 队列、车道、心跳、日志、停止开关 |
| 私钥 | `~/.config/mivo-github-apps/praise-merge.pem`（600） | App `praise-merge`（ID 5642127）的私钥，只在 Mini 上 |

Cindy 里还有一个伙伴「合并伙伴」（主力电脑 Mini）。它负责接收合并请求和通知用户。

**伙伴只合 Mivo**（2026-11-08 起，PraiseZhu/praise-merge#30）：运行配置 `config/policy.json` 里只有 `xindong/mivo-canvas-plugin`（改前的备份是 `policy.json.bak-20261108-personal`）。个人仓改由说「合并」的会话自己合；个人仓车道的代码保留，policy 里不放个人仓。praise-qa[bot] 开的 Mivo PR 由引擎自动接单，见下文「bot PR 自动接单」。

**巡检入口是 Cindy 脚本调度 `12fe125a-3088-45aa-a021-d9420d30e698`**（2026-11-08 起）：`scripts/cindy-tick.mjs`，每 1 分钟一轮，零 token。每轮跑一次 `praise-merge tick` 并写心跳 `state/heartbeat.json`；有要人看的事件或健康告警时，才用 `sessions.dispatch` 叫醒合并伙伴，否则安静结束。伙伴的模型例行任务「合并引擎巡检」已停用。

## 部署与更新

```sh
cd <本仓>
scripts/deploy.sh                 # 演练：列出会改什么
scripts/deploy.sh --apply         # 真的拷到 ~/praise-merge-runtime/
node ~/praise-merge-runtime/scripts/doctor.mjs --config ~/praise-merge-runtime/config
```

- `deploy.sh` 不会覆盖运行目录里的 `config/app.json`、`config/policy.json`，也不碰 `state/`、`DISABLED`，以及宿主管理的调度前置检查目录 `scripts/schedule-checks/`（本仓不放这个目录，部署时不删）。
- 正在跑的一轮不受影响，下一轮起就用新代码。
- `doctor` 必须全部 pass 才算部署完成。它检查：私钥存在且权限是 600、私钥不在 `~/AI-Agent` 下、两个安装都能换到令牌、令牌权限与期望的 8 项完全一致、policy 里的仓都在安装范围内。

## 合并伙伴（Cindy 伙伴）

| 项 | 取值 |
|---|---|
| 伙伴 | 「合并伙伴」，botId `bot_1793971930675_jl0cwg`，主力电脑 Mini |
| 模型 | 主模型 `deepseek/deepseek-v4.1-flash`（Pi，档位 medium）；备用 `claude-sonnet-5-5`（档位 medium），主模型不可用时自动接上。理由：工作只是跑命令、转述结果；2026-11-06 实测主模型每轮巡检约 $0.005、4 秒，入队和巡检都按手册做对了 |
| 关联项目 | Project PraiseMerge |
| 例行任务 | 见下表；巡检不在这里，由脚本调度 `12fe125a` 跑 |
| skill 投递地址 | live skill 目录 `pr-merge/partner.json` 里写的是伙伴主聊天的会话 id |

### 例行任务

都只跑脚本、转述结果，不让模型自己去 GitHub 查数据。命令都在 `~/praise-merge-runtime` 下执行，带上 `PRAISE_MERGE_CONFIG=~/praise-merge-runtime/config`。

| 例行任务 | 触发 | 跑什么 | 什么时候通知用户 |
|---|---|---|---|
| ~~合并引擎巡检~~ | 已停用（2026-11-08） | 改由脚本调度 `12fe125a` 跑 `scripts/cindy-tick.mjs`，每 1 分钟 | 脚本发现要人看的事件（自动接单、合入、入队、移出队列、过期、拒收、冻结、暂停）或健康告警时叫醒伙伴；伙伴按下文「巡检发现事件时」回复。只有 `would_*` 或没有事件时不叫醒 |
| 影子对账日报 | 每天 21:30 | `node scripts/shadow-report.mjs` | 每天都发：原样转述脚本输出。第一行带 ⚠️ 时放在最前面醒目提示 |
| 每日自检 | 每天 09:00 | `node scripts/daily-check.mjs` | 输出 `ok` 时安静结束；否则逐条转述 |

脚本调度的运行记录在 Cindy 定时任务列表里看（调度 `12fe125a` 的最近一次 run 的状态和结果）。

## 合并伙伴怎么工作

伙伴的人设里写着：每次处理前先读本节，以本节为准。

### 收到「praise-merge 合并请求」

消息由 skill「合并」发来：第一行是 `praise-merge 合并请求`，后面是一个 JSON 代码块。

1. 把 JSON 原样写进 `~/.local/state/praise-merge/requests/<时间戳>.json`。
2. 执行 `node ~/praise-merge-runtime/bin/praise-merge enqueue --file <那个文件>`，配置目录用 `PRAISE_MERGE_CONFIG=~/praise-merge-runtime/config`。
3. 把输出里的 `accepted`、`rejected` 回复给用户，每个 PR 一行，带链接。

不改请求内容，不替用户补 PR，也不自己合并任何 PR。

### 收到「praise-merge 通知登记」（2026-11-08 起）

消息由「批准执行」的 lead 发来（PraiseZhu/praise-merge#40）：第一行是 `praise-merge 通知登记`，后面是一个 JSON 代码块，例如：

```json
{ "schema": "praise-merge/notify@1", "notify_session": "<deviceId>::<lead 会话 id>", "prs": [{ "repo": "xindong/mivo-canvas-plugin", "number": 2017 }], "registered_at": "2026-11-08T15:00:00.000Z" }
```

本人 Mivo PR 正文写了「合并顺序」就自动合入，没有「合并」请求带 `notify_session`。lead 在 PR 转正式时发这条登记，伙伴合入后才知道该叫醒谁（见「合入后通知发起合并的会话」）。

1. 把 JSON 原样写进 `~/.local/state/praise-merge/requests/<时间戳>-notify.json`。文件名以 `.json` 结尾，合入后查地址的命令才读得到。
2. 不执行 `enqueue`，不改队列：这条登记不是合并请求，也不是合并授权。
3. 回复用户一句：哪个 PR（带链接）合入后会通知哪个会话。

### 授权和改动（2026-11-07 起）

授权不绑定改动，GPT 单审和 e2e 绑定改动（#24）。用户说过「合并」后，agent 又改了 PR，授权仍然有效，不用请用户重新说「合并」；授权写入超过 7 天、写入方不是 PraiseZhu、结论不是 success 时照旧不合。授权绑定 PR：它的 description 是 `patch:<patch-id> pr:<owner/repo>#<号> by:<会话 id>`，`pr:` 和当前 PR 对不上时不合，原因是 `authorization: pr_mismatch`，这时要用户在这个 PR 的会话里重新说「合并」。没有 `pr:` 的旧格式授权仍绑定改动：PR 改过就报 `authorization: patch_changed`，也要重新说「合并」。改过的这一版要重新做 GPT 单审和 e2e：`status` 里的原因是 `gpt-review: patch_changed` 或 `e2e: patch_changed` 时，缺的是新一版的审查或 e2e 证据，不是授权，转告用户时不要让用户重新说「合并」。

### 哪些仓能接单（2026-11-07 起）

2026-11-08 起运行配置里只有 Mivo：个人仓的请求会被拒收，原因 `repo_not_in_policy`。这是预期结果，回复用户「个人仓由发起合并的会话自己合」，不要去改 policy。以下是 policy 里加回个人仓时的规则。

运行配置 `config/policy.json` 里写上 `PraiseZhu/*` 默认条目后，PraiseZhu 名下全部仓（含 fork、以后新建的仓）都能接单，不用再逐个加仓。写法和含义见 README「policy：逐仓条目与 `PraiseZhu/*` 默认条目」，要点：

- 逐仓条目优先；没有逐仓条目才用 `PraiseZhu/*`；两者都没有才拒收，原因 `repo_not_in_policy`。排除仓照旧拒收，原因 `repo_excluded`。
- 默认条目只能走个人仓车道，`e2e` 必须是 `required`，`required_checks` 一般写 `"all"`：head 上除 `praise-merge/*` 证据以外的全部检查都要通过。
- head 上一项检查都没有的 PR，推送满 10 分钟才会合。不满 10 分钟时 `status` 里的原因是「head 上还没有任何检查，等 CI 出现」，这是正常等待，不用转告用户。
- `doctor` 只核对逐仓条目里的仓是否在 App 安装范围内；默认条目覆盖的仓不在核对范围里，App 没装到的仓在 `enqueue` 读 PR 时就会报错，把报错原样回给用户。

### Mivo 接受的目标分支（2026-11-07 起）

Mivo（`xindong/mivo-canvas-plugin`）的 PR 只收两种目标分支：`main` 和 `integration/*`（只认一层，如 `integration/cindy-media-phase2`）。其他目标（如 `release/x`、`integration/a/b`）在 `enqueue` 时直接拒收，原因写成 `base 期望 main 或 integration/*，实际 <分支>`，伙伴按上面第 3 步回给用户。引擎记下接单时的目标分支；之后 PR 被改到别的分支，就留在队列、不合，原因写 `base: 期望 <接单时的分支>，实际 <现在的分支>`。

合进集成分支的条件不低于 main，每轮按 PR 的目标分支分别检查：

| 条件 | main | `integration/*` |
|---|---|---|
| 生效规则里的必需检查 | 规则集 `main-required-checks`，少了一项就冻结 Mivo 车道 | 规则集 `integration-protect`（26050842），审查检查叫 `review-pr (integration)`，其余和 main 同名；少了一项同样冻结 Mivo 车道 |
| 分支头 CI | main 当前头的 `ci.yml` push run 成功，且这个提交上全部检查都绿（见下文「目标分支全绿才合」），不满足就暂停整条车道 | 同一条规则看该集成分支当前头：`ci.yml` push run 成功且全部检查都绿，不满足只让这个 PR 留在队列（`base_ci_not_success` / `base_checks_not_green`），不挡 main 的 PR |
| PR 自身 | 作者 PraiseZhu、praise-qa[bot]、huangkexin-commits 或 shaoshenze-rgb 或 zhanxinyi-lab（自动接单的条目还要仍带接单时的标签）、非 Draft、当前 head 的必需检查全过（写入方是 integration 15368）、讨论全解决、合并状态 CLEAN | 同左，审查检查换成 `review-pr (integration)` |
| 落后时 | 合并状态 `CLEAN` 就直接合，不追 main（main 没开 strict，落后的 PR 一般是 `CLEAN`）；只有 `BEHIND` 才 `update-branch` 追 main | 同一条规则：`CLEAN` 直接合。集成分支 2026-11-12 起也关了 strict（用户定），落后的 PR 一般是 `CLEAN`；万一是 `BEHIND`，才 `update-branch` 追该集成分支，对着该分支本轮钉住的头比 |
| 合并 | squash，锁定检查过的 head | merge（最近 5 个合进集成分支的 PR 3 个用 merge；squash 会丢同步 main 的祖先关系），锁定检查过的 head |
| 合并后核对 | 合并提交唯一的父提交是检查时的 main 头，对不上就冻结（`merged_on_moved_main`） | 合并提交的父提交是检查时的集成分支头和 PR head，对不上就冻结（`merged_on_moved_base`） |

冻结范围不变：只冻结 Mivo 车道。main 和各集成分支的头分开记在车道状态里（`checkedMainSha`、`checkedBaseShas`），一个分支前进不会让另一个分支的 PR 被误判。main 不全绿时整条车道暂停，集成分支的 PR 也一起等。

### 目标分支全绿才合（2026-11-08 起）

用户 2026-11-08 定：「main 上红了但伙伴还在合并，加 1 个条件限制，要等 main 全绿后才恢复，main 上转绿要让伙伴第一时间恢复」（PraiseZhu/praise-merge#32）。之前引擎只看 `ci.yml`，main 上 CodeQL 失败时照样合了 #1997。

- **全绿才合**：目标分支（main 和 `integration/*`）当前提交被 push 时跑出来的检查都绿，车道才合并、追分支或入队。检查先按来源筛（见下一条），再按写入的 App 和名字分组取最新一次（id 最大；同名检查来自不同 App 时各自算，别的 App 的成功盖不掉这个 App 的失败；定时重跑的同名 CodeQL 也盖不掉 push 那次的结果），必须是 completed 且结论是 `success`、`skipped` 或 `neutral`；commit status 有条目时，合并状态必须是 `success`，没有条目不算不绿；一个 push 触发的 check run 都没有也不算绿。check run 和 workflow run 都读完全部分页，读取失败或读不全按不绿处理。
- **只看 push 触发的检查**（2026-11-08 起，PraiseZhu/praise-merge#36）：GitHub Actions 的检查按所属 workflow run 的触发事件算，只有 `push` 算；CodeQL 默认配置的 workflow run 事件是 `dynamic`，只算名字是「Push on <分支>」（Code Quality 的带「Code Quality: 」前缀）的那次，定时的「Scheduled」不算。`workflow_dispatch`（如审查机审别的 PR 跑的 `review-pr`）、`schedule`、`issue_comment`、`workflow_run`（如 PR gate rerun）、`issues` 触发的检查也挂在 main 头提交上，但跟 main 本身无关，不算：#33 上线后 Mivo main `08b54b5f` 上 78 个工作流运行只有 3 个是 push，审查机几乎总在审某个 PR，车道因此连停 1 个多小时。别的 App（不是 GitHub Actions）写的检查照旧都算；找不到所属 workflow run 的 Actions 检查不知道来源，按不绿。用户原意是「main 红了就停」，别的 PR 的审查在跑不算 main 红。
- **暂停**：main 不满足时车道暂停（不冻结），原因 `main_checks_not_green: <提交> <检查名=状态>`，失败的排在还没跑完的前面，最多列 10 个。`ci.yml` 本身还没成功时原因仍是 `main_ci_not_success`。原因变了才再发 `lane_paused`；同一原因的后续轮次只是继续暂停，不再叫醒伙伴。
- **恢复**：转全绿后的下一轮巡检就恢复（脚本调度每 1 分钟一轮，最多约 1 分钟），发 `lane_resumed`，同一轮接着处理队列。不用人执行 `unfreeze`。
- **集成分支**：同一条规则，不满足只让合进这个分支的 PR 留在队列，原因 `base_checks_not_green: <分支> <提交> <检查名=状态>`，不暂停车道。
- **已知代价**：main 上任何一项 push 触发的检查长期红（包括非必需检查，以及 GitHub 下载 CodeQL 包 504 这类外部故障），车道会一直暂停，伙伴会收到 `lane_paused`。这时要人去重跑或修好那项检查。反过来，定时 CodeQL 等非 push 触发的检查红了不挡合并，它发现的问题要靠下一次 push 的 CodeQL 或人去看。
- 调度 `12fe125a` 上曾挂过前置检查 `scripts/schedule-checks/token.mjs`（同一条规则的止血版，main 不全绿就跳过整轮 tick）。2026-11-08 本规则部署后已摘掉（不摘的话 main 不全绿的那几轮 tick 不跑，引擎发不出 `lane_paused`，伙伴收不到通知）；脚本文件留在运行目录作回退，`deploy.sh` 不删这个目录。

### bot PR 自动接单（2026-11-08 起）

用户 2026-11-08 定：praise-qa bot 的 Mivo PR 满足标准自动合，不用用户说「合并」。运行配置里 Mivo 条目带上 `auto_intake`（现行写法：`{ "authors": ["praise-qa[bot]", "PraiseZhu", "huangkexin-commits", "shaoshenze-rgb", "zhanxinyi-lab"], "label": "review:merge-ready", "base": ["main", "integration/*"], "label_actors": ["praisebuild[bot]", "PraiseZhu"], "order_line_authors": ["PraiseZhu"] }`，bot、本人和同事（#44、#46，2026-11-10 起）都在里面；写法见 README「自动接单」）后，引擎每轮处理队列前自己接单：

- **接单条件**：open、非 Draft、作者在 `auto_intake.authors` 里、目标分支在 `auto_intake.base` 里、带 `auto_intake.label` 标签。一轮只发一次只读列表请求。
- **合进集成分支的也接**（2026-11-09 起，#42）：`base` 带 `integration/*`，合进集成分支（如 `integration/cindy-media-phase2`）的 bot PR 和本人 PR 同样自动接单，按上文「Mivo 接受的目标分支」里集成分支的条件合。用户问「为什么没接」时，先看 `auto_intake` 的作者和目标分支，不要只凭本节标题说「只接 bot」。
- **标签必须是审查机挂的**：对其余条件都满足的 PR，读 issue events 找这个标签最近一次 `labeled` 事件，操作者必须在 `label_actors` 里（审查机是 `praisebuild[bot]`，写入关闭时退回 `PraiseZhu`）。只有 Triage 权限的人补挂标签不会触发自动合并。读不到、分页没读完、不在名单都按不满足：不接单；已在队列的不合，原因 `auto_intake_label_actor`，`status` 里看得到，不用转告用户，除非用户问起这个 PR。
- **接单出错不中断本轮**：列表请求失败（5xx、限流）、接单时读不到标签操作者，或已在队列的自动接单条目处理时读不到标签操作者，都照常处理已有队列（读不到的条目照旧不合），本轮最后合成一条原因，产生 `auto_intake_failed` 叫醒伙伴。原因按 PR 号排序（列表请求失败排最前），和列表返回顺序无关；同一原因接着失败只记日志（`auto_intake_still_failing`），恢复时产生 `auto_intake_recovered`。已入队条目这一轮没轮到处理（比如 main CI 还在跑）时，沿用它上次的结果，不算恢复。
- **不重复接单**：队列里已有这个 PR 的未完成条目就跳过；已 merged / closed 的跳过；expired 的重新接单；dequeued / rejected / blocked_by_dependency 的只有 head 变了才重新接单。
- **标签被摘掉就不合**：处理时 PR 已没有这个标签，留在队列里，原因 `auto_intake_label_missing`。审查机重新挂上标签后照常合。
- 接单记录的会话是 `auto-intake`，队列里看得到；它没有合并请求文件。「批准执行」的 lead 在 PR 转正式时发过「praise-merge 通知登记」的，合入后按登记的地址通知 lead（见「合入后通知发起合并的会话」）；没登记过的（如 bot PR）查不到地址，不发通知是正常的（补关 issue 照做）。
- 授权按接单时间算 7 天。过期后引擎下一轮会重新接单，`expired` 事件照常转告，但要写明它会自动重新接单，不用用户说「合并」。
- Mivo 车道冻结时不接单，解冻后下一轮再接。

### 本人 PR 按正文合并顺序自动接单（2026-11-08 起）

用户 2026-11-08 定：本人的 Mivo PR 也自动合，但合并顺序由写 PR 的会话写进正文，伙伴不盲合（PraiseZhu/praise-merge#38）。运行配置的 `auto_intake` 写 `"authors": ["praise-qa[bot]", "PraiseZhu", "huangkexin-commits", "shaoshenze-rgb", "zhanxinyi-lab"]` 和 `"order_line_authors": ["PraiseZhu"]` 后生效。

- **正文写法**：一行 `合并顺序：无`（没有依赖），或 `合并顺序：等 #12、xindong/mivo-canvas-plugin#13 合入后`（这一行里每个 `#号` / `owner/repo#号` 都是依赖）。会话开 PR 和转 Ready 前跑的 `check-pr-body.sh` 会要求这一行。
- **接单**：条件和 bot PR 一样（open、非 Draft、base main、审查机挂了 `review:merge-ready`），另要求正文的「合并顺序」有效。无效就不接，记一条 `merge_order_invalid` 叫醒伙伴；同一 PR 同一 head 同一原因只报一次。
- **排队**：每轮处理前重新读正文。依赖都已合入才合；依赖还开着就等（不叫醒）；依赖关闭没合、读不到、正文变无效就不合，记 `merge_order_blocked` 叫醒伙伴，原因不变不重复报。
- 用户说「合并」接的条目照旧按请求里的 `after` 排队。

### 巡检发现事件时

按事件类型回复用户：

| 事件 | 回复 |
|---|---|
| `auto_intake` | 一句话：自动接了哪个 PR（带链接；bot 的还是本人的，合进集成分支的写明分支）；事件里有 `reason` 时说明是重新接单 |
| `auto_intake_failed` | 自动接单出错的原因（列表请求失败，或读不到某个 PR 的标签操作者）；说明已有队列照常在处理。原因里是 403 时附上 `doctor` 的输出 |
| `auto_intake_recovered` | 一句话：自动接单恢复了 |
| `merge_order_invalid` | 哪个本人 PR（带链接）没被自动接单、原因；提醒负责它的会话在正文补好「合并顺序：」一行，或者用户直接说「合并」 |
| `merge_order_blocked` | 哪个本人 PR 卡在合并顺序上、原因（依赖关闭没合、读不到依赖、正文无效）；要用户或负责的会话改正文 |
| `merged` / `enqueued` | 一句话：哪个 PR 合入了，或者进了合并队列 |
| `dequeued` / `merge_refused` | PR 号和原因，提醒用户看 CI 或冲突 |
| `expired` / `blocked_by_dependency` / `rejected` / `closed` | PR 号和原因：这个 PR 已退回给用户，需要的话重新说「合并」 |
| `lane_frozen` | **醒目提示**：哪个仓的车道冻结了、原因是什么。原因是 `merged_on_moved_main` / `merged_on_moved_base` / `merge_parent_unverified` / `merge_result_unknown` 时，附上 PR 链接和目标分支（main 或原因里写的集成分支）最新一次 `ci.yml` 的结论；用户确认没问题后，执行 `praise-merge unfreeze <owner/repo>` |
| `lane_paused` / `lane_resumed` | 一句话说明原因。原因是 `main_checks_not_green` 时列出原因里的检查名，说明 main 转全绿后约 1 分钟内自动恢复、不用用户操作；同一项检查一直红着时，提醒用户去重跑或修 |
| `main_ci_red` / `integration_ci_red` | **先发飞书，再在会话里回复**：按下一节「CI 变红飞书通知」发给用户 |
| `integration_ci_recovered` | 一句话：哪个集成分支转绿了，在等它的 PR 会照常往下合。不发飞书 |
| `health_alert` | **醒目提示**：心跳中断或连续失败。附上 `doctor` 的输出 |

要看现状时，执行 `praise-merge status`。

### CI 变红飞书通知（2026-11-12 起，PraiseZhu/praise-merge#48）

用户 2026-11-12 定：「我的集成分支 CI 变红时 给我发飞书通知；主 main 红时也给我发飞书通知」。起因：`integration/file-line-limit` 的 CI 失败后约 1.5 小时没人知道，合进它的 5 个 PR 一直卡着。

- **看哪些分支**：Mivo 的 `main`，以及在用的集成分支：Mivo 开放 PR 的目标分支，或同仓 PR 的源分支，是 `integration/*` 的。没有开放 PR 在用的集成分支不看。`main` 暂停、或某个集成分支上没有排队条目时也照看。
- **什么算红**：分支当前提交被 push 时跑的 `ci.yml` 已结束且结论不是 `success`；或 `ci.yml` 成功，但同一提交上 push 触发的其他检查有已结束、结论不是 `success` / `skipped` / `neutral` 的，或 commit status 有 `failure` / `error`。还在跑、读不到、来源未知都不算红，不通知。
- **只发一次**：同一分支同一提交只发一次 `main_ci_red` / `integration_ci_red`。换了新提交又红再发。集成分支之后转绿（同一提交重跑，或新提交）发一次 `integration_ci_recovered`；`main` 转绿照旧是 `lane_resumed`。
- **读失败**：列开放 PR 或读某个分支失败时，这一轮不发红灯，只在日志记 `ci_watch_failed`，不叫醒伙伴，队列照常处理。
- **省请求**：开了自动接单、列表又不按目标分支过滤时（线上配置），复用自动接单这一轮拉到的开放 PR 列表。分支判过绿以后，同一提交每轮只读一次分支头。

伙伴收到 `main_ci_red` 或 `integration_ci_red` 时，按顺序做：

1. 用 Cindy 飞书机器人工具 `cindy_feishu_bot` 的 `send_message_to_user` 给用户发一条消息。它发到用户和机器人的私聊，不用填聊天 id。伙伴跑在 Pi 上，经 `cindy_mcp` 网关调用：先 `cindy_mcp_list_tools` 找到 `cindy_feishu_bot`，再 `cindy_mcp_call_tool`（`server` 填 `cindy_feishu_bot`，`tool` 填 `call_tool`，`args` 填 `{"name":"send_message_to_user","args":{"text":"<正文>"}}`）。正文按下面写，事件里的字段原样代入：

   ```
   **Mivo CI 变红：<branch>**
   - 提交：`<head 前 8 位>`
   - 失败：<reason 里提交号后面、括号前面的部分>
   - 影响：<main：合并通道已暂停，转全绿后约 1 分钟自动恢复｜集成分支：在用的 PR 是 reason 括号里的那几个，合进它的 PR 先不合>
   - 查看：https://github.com/xindong/mivo-canvas-plugin/actions?query=branch%3A<branch>
   ```

2. 返回 `ok: true` 后，在会话里用一句话说明发了什么。
3. 返回 `NO_CHAT_CONTEXT`：机器人还没绑定用户。在会话里醒目写明「飞书没发出去：请先在飞书里私聊一次 Mini 上 Cindy 的飞书机器人完成绑定」，并把上面的正文贴在会话里。不重试。
4. 返回 `SEND_FAILED` 等其他错误：在会话里写明错误码和原文，把正文贴在会话里。限流类错误等一秒重试一次，其余不重试。

同一轮里多个分支变红，每个分支各发一条。

### 合入后通知发起合并的会话（2026-11-07 起）

`merged` 事件除了告诉用户，还要通知发起这次合并的会话：「批准执行」的 lead 收到通知才会派下一批（用户 2026-11-07 定）。合并请求或通知登记里的 `notify_session` 就是这个会话的地址（`<deviceId>::<会话 id>`），伙伴把它们原样存在 `requests/` 下。自动接单合入的本人 PR 没有合并请求，地址来自 lead 发的通知登记（2026-11-08 起，PraiseZhu/praise-merge#40）。对每条 `merged` 事件按顺序做：

1. 补关 PR 声明要关闭的 issue：`node scripts/close-linked-issues.mjs <owner/repo> <号>`（在本仓目录跑，用本机 gh 的 PraiseZhu 登录）。Mivo 仓合并后 GitHub 不会按「Closes」自动关 issue（2026-11-07：#1949 合入后 #1464 一直开着），App 也没有 issues 写权限，所以由伙伴补关。先关再通知：lead 收到通知后按 issue 是否关闭判断子 issue 做完没有、放不放行下一批。输出里 `closed` 非空时，在给用户的回复里写一句关了哪些 issue；`failed` 非空或退出码不是 0 时，列出 issue 号和错误，请用户手动关。
2. 查通知地址，把 `<owner/repo>` `<号>` 换成事件里的 `repo` 和 `pr`：

   ```sh
   node -e 'const fs=require("fs"),p=require("path");const d=p.join(process.env.PRAISE_MERGE_STATE||p.join(require("os").homedir(),".local/state/praise-merge"),"requests");const [r,n]=process.argv.slice(1);const files=fs.existsSync(d)?fs.readdirSync(d).filter(f=>f.endsWith(".json")).map(f=>p.join(d,f)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs):[];for(const f of files){let q;try{q=JSON.parse(fs.readFileSync(f,"utf8"))}catch{continue}if((q.prs||[]).some(x=>String(x.repo).toLowerCase()===String(r).toLowerCase()&&Number(x.number)===Number(n))){if(q.notify_session)console.log(q.notify_session);break}}' <owner/repo> <号>
   ```

   只看最新一份包含这个 PR 的请求或登记：它带 `notify_session` 就输出，不带就输出为空（不通知），不回退去用更旧请求里的地址。
3. 有地址就用 Cindy 的 `send_to_session` 发给它（`target_session_id` 填这个地址），正文只有一行：`praise-merge 已合并 <owner/repo>#<号>`。
4. 回执是 `REMOTE_DEVICE_OFFLINE` / `REMOTE_DISABLED` / `REMOTE_UNAVAILABLE`：给用户的回复里加一句「没通知到发起合并的会话，请在那个会话里说『继续』」。`DELIVERY_UNKNOWN`：先用 `get_chat_history` 查对方收到没有，确认没收到再重发一次。

## 影子模式与真实合并

现状：2026-11-07 起 `shadow` 为 `false`（PraiseZhu 定），「影子对账日报」例行任务已暂停。

`config/app.json` 里 `"shadow": true` 是影子模式：照常判断，但只记录 `would_merge`、`would_update_branch`、`would_enqueue`，不发任何写请求。

打开真实合并之前，以下三件事都要先满足：
1. 影子运行满 7 天。
2. 每条 `would_*` 都和人工合并的结果一致，并且没有出现过「本来会合并」但实际不该合的 PR。
3. App 在 Mivo main 的 `main-merge-allowlist` 豁免名单和分支保护推送名单里（2026-11-06 已加）。Mivo 不开合并队列，App 直接合并，见 README「Mivo 车道」。

打开方法：把 `config/app.json` 的 `shadow` 改成 `false`，下一轮就生效。改回 `true` 就立刻回到影子模式。

## 停止与回滚

- **全停**：`touch ~/.local/state/praise-merge/DISABLED`。下一轮起不发任何请求，配置坏了也照样有效。删掉这个文件即可恢复。
- **只停合并、保留判断**：把 `shadow` 改回 `true`。
- **停巡检**：在 Cindy 定时任务里暂停脚本调度 `12fe125a`（`scripts/cindy-tick.mjs`）。
- **轮换私钥**：在 GitHub App 设置里生成新私钥，替换 Mini 上的 pem 文件（权限 600），跑一次 `doctor`，然后删掉旧私钥。

## 看日志

```sh
tail -n 50 ~/.local/state/praise-merge/logs/events-$(date +%F).jsonl
node ~/praise-merge-runtime/bin/praise-merge status
```

## 已知限制

- 脚本调度彻底停了时，没有一轮能去发告警。这时要看 Cindy 定时任务列表里调度 `12fe125a` 的运行记录。
- `mergeable_state` / `mergeStateStatus` 是按 App 自己的身份读的。影子期间要和 PraiseZhu 看到的值对一遍，见总 issue「上线后验证」。
