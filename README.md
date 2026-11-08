# praise-merge

用 GitHub App `praise-merge` 按各仓的合并标准，自动合并 PraiseZhu 负责的 PR。总 issue：PraiseZhu/praise-merge#1。项目约定见 [CLAUDE.md](./CLAUDE.md)，版本管理见 [VERSIONING.md](./VERSIONING.md)。

**先读这个**：[docs/how-it-works.md](docs/how-it-works.md) 用一页讲清合并伙伴现在的完整机制。

能不能合由本仓的脚本逐项判断，不交给模型。合并只用 App 令牌，失败就停下报错，不改用个人账号，也不调用 `gh`。

**现状（2026-11-08 起，PraiseZhu/praise-merge#30）**：伙伴只合 Mivo（`xindong/mivo-canvas-plugin`）。运行配置的 policy 里只有 Mivo 一个仓；个人仓改由说「合并」的会话自己合。个人仓车道的代码（`src/lanes/personal.mjs`、审查证据）保留，policy 里加回个人仓条目就照旧生效。praise-qa[bot] 开的 Mivo 修复 PR 由引擎每轮自己找出来接单，见「自动接单」。巡检入口是 Cindy 脚本调度 `12fe125a`（`scripts/cindy-tick.mjs`，每 1 分钟），见 [docs/operations.md](docs/operations.md)。

## 命令

```sh
bin/praise-merge enqueue --file request.json   # 接收一份合并请求，写进队列
bin/praise-merge tick                          # 跑一轮：逐仓检查门禁，满足才合
bin/praise-merge status                        # 列出队列和车道状态
bin/praise-merge unfreeze <owner/repo>         # base CI 红了以后人工确认，解冻车道
```

配置目录：`--config <dir>` 或 `$PRAISE_MERGE_CONFIG`，默认本仓 `config/`。需要 `app.json` 和 `policy.json`，示例见 `config/*.example.json`。真实配置和私钥不进仓库。

状态目录：`$PRAISE_MERGE_STATE`，默认 `~/.local/state/praise-merge/`，不要放在 Syncthing 同步目录里。

## 合并请求

skill「合并」生成这份请求，交给 Mini 上的合并伙伴：

```json
{
  "schema": "praise-merge/request@1",
  "session_id": "example-session",
  "session_title": "#12-示例任务丨1106",
  "notify_session": "<deviceId>::example-session",
  "machine": "Mini",
  "authorized_at": "2026-11-06T12:00:00Z",
  "authorization_text": "合并",
  "prs": [
    { "repo": "xindong/mivo-canvas-plugin", "number": 12, "head_sha_at_auth": "0123456789abcdef0123456789abcdef01234567" },
    { "repo": "xindong/mivo-canvas-plugin", "number": 13, "head_sha_at_auth": "89abcdef0123456789abcdef0123456789abcdef", "after": ["xindong/mivo-canvas-plugin#12"] }
  ]
}
```

- `after`：要等这些 PR 合进去之后才合。成环时整份请求拒收。
- 授权有效期 7 天，从 `authorized_at` 算起，过期还没合的 PR 退回。
- 入队时用 App 只读确认作者和状态。作者按车道认：Mivo 车道是 `PraiseZhu` 或 `praise-qa[bot]`（REST 的 `user.login` 写法，2026-11-08 起），个人仓车道只有 `PraiseZhu`；不在名单里就拒收，原因 `author 期望 <名单>，实际 <作者>`。PR 必须是 open 状态。
- `makecindy/cindy`、`xindong/mivo-canvas`、`xindong/XDMaker` 一律不处理。

## 个人仓门禁

以下全部满足才合，任何一项不满足就留在队列里，并记下原因：

| 门禁 | 要求 |
|---|---|
| `author` | 作者是 `PraiseZhu` |
| `not_draft` | 不是 Draft |
| `base_is_default` | base 是仓库默认分支 |
| `threads_resolved` | 没有未解决的讨论 |
| `required_checks` | policy 里列出的检查在当前 head 上全部通过；写 `"all"` 时见下一节 |
| `mergeable_clean` | App 看到的 `mergeable_state` 是 `clean` |
| `evidence` | 三样证据：PraiseZhu 的合并授权（7 天有效）与 GPT 单审必须有；policy 里 `e2e` 为 `required` 时 e2e 也必须有（见下一节） |

- **能直接合就直接合，不碰 PR**（2026-11-07 起）：落后 base 不算门禁失败。GitHub 判定可以合并（`mergeable_state=clean`）、其余门禁全过时直接合，不先 `update-branch`。
- 只有 GitHub 要求先同步（分支开了「必须是最新」，`mergeable_state=behind`），而且只差 `mergeable_clean`（以及随它变化的 `required_checks`）时，引擎才调用 `update-branch` 替 PR 追上 base，等新 head 的 CI 跑完再判断。
- 已知代价：PR 和 base 新改动之间的冲突，要合并后 base 的 CI 才能发现。兜底见下一条：base CI 红了车道就冻结。
- 合并命令带 `sha` = 本轮检查时读到的 head：检查之后有人推送，合并就会失败。
- 同一仓一次只合一个 PR。合并后要等 base 分支的 CI 出结论，才会合下一个；base 的 CI 红了，车道就冻结，直到执行 `unfreeze`。

## policy：逐仓条目与 `PraiseZhu/*` 默认条目

`policy.json` 的 `repos` 里可以写一个 `PraiseZhu/*` 默认条目（2026-11-07 起；2026-11-08 起运行配置里没有它，伙伴只合 Mivo，代码照旧支持）。没有逐仓条目的 PraiseZhu 仓（含 fork、以后新建的仓）都按它接单和判断，不用再逐个加仓：

```json
"PraiseZhu/*": { "lane": "personal", "required_checks": "all", "e2e": "required", "merge_method": "squash" }
```

- **优先级**：逐仓条目优先；没有逐仓条目才用默认条目；两者都没有就拒收（`repo_not_in_policy`）。`makecindy/cindy`、`xindong/mivo-canvas`、`xindong/XDMaker` 照旧一律拒收（`repo_excluded`）。
- **只限个人仓车道**：默认条目的 `lane` 只能是 `personal`，`e2e` 只能是 `required`（不写也按 `required`）。别的 owner 的通配条目（如 `xindong/*`）、`lane` 为 `mivo` 的通配条目，加载配置时直接报错，错误信息带条目名。
- **`"required_checks": "all"`**：当前 head 上除 `praise-merge/*` 证据 status 以外的全部 check run 和 commit status 都要通过；有一项失败或还在跑就不合，原因列出 `名字=状态`。逐仓的 `personal` 条目也可以这样写，`mivo` 车道不行。
- **一项检查都没有时**：可能是 CI 还没出现。head 提交推送到 PR 分支（按仓库活动接口里的推送时间）满 10 分钟才放行；不满 10 分钟就留在队列，原因写「head 上还没有任何检查，等 CI 出现」。读不到推送时间也不合。
- 门槛不比逐仓条目低：三样证据、作者、非 Draft、默认分支、讨论全解决、`mergeable_state=clean` 全部照旧。

## 审查证据

个人仓的合并条件是三样证据都在：你的合并授权、GPT 单审通过、e2e 通过（e2e 为 `required` 时）。2026-11-08 起运行配置里没有个人仓，这一节只在 policy 加回个人仓条目时生效。证据是写在 PR head 上的 commit status。用户在会话里说「合并」时，`pr-merge` skill 写授权证据，并把本会话已有的 GPT 单审、e2e 结论写成证据（没有结论就不写，PR 不会被合）。手动写用：

```sh
bin/praise-merge attest --repo PraiseZhu/project-keel --pr 12 --head <审查实际看的 40 位 SHA> \
  --kind gpt-review --result pass --by gpt-5.5
```

- `attest` 和合入后补关 issue 的 `scripts/close-linked-issues.mjs`（见 docs/operations.md「合入后通知发起合并的会话」）是仅有的两处调用 `gh` 的地方，用的是调用者本机的 PraiseZhu 登录。它们不碰 App 私钥；合并本身仍只用 App 令牌。
- context 是 `praise-merge/authorization`、`praise-merge/gpt-review` 或 `praise-merge/e2e`。GPT 单审和 e2e 的 description 是 `patch:<patch-id> by:<执行者>`；授权的 description 是 `patch:<patch-id> pr:<owner/repo>#<号> by:<会话 id>`。超过 140 字时只截短 by，patch 和 pr 原样保留。
- PR 在 `--head` 之后又有新提交时，拒绝写入。
- 门禁从当前 head 往回找最新的一条证据，要求同时满足：结论是 success；写入方是 `PraiseZhu`；GPT 单审和 e2e 的 patch-id 等于当前 PR 的 patch-id（授权的规则见本节最后一条）。
- 写入方从逐条列表接口 `GET /commits/{sha}/statuses` 按 status id 读（汇总接口 `/status` 不返回 `creator`）；读不全就报错，门禁按失败处理。
- patch-id 只看 PR 自身改了什么，不看行号：只追了 base 时它不变，证据继续有效；PR 内容一变，或者追 base 时解决了冲突，它就变，要重新审。
- 空白照原样计入。
- 授权证据写入超过 7 天就过期，要重新说「合并」。
- 授权不绑定改动，GPT 单审和 e2e 绑定改动（2026-11-07 起，#24）：用户说过「合并」后，agent 再改 PR，授权仍然有效；但改过的这一版要重新做 GPT 单审和 e2e，新证据的 patch-id 等于当前 PR 的才合。授权写在说「合并」时的 head 上，门禁从当前 head 往回找到它。
- 授权只对写明的 PR 有效：commit status 挂在提交上，不属于哪个 PR，所以门禁要求授权里的 `pr:` 等于当前 PR（不分大小写），对不上就不合，原因是 `authorization: pr_mismatch（期望 <当前 PR>，实际 <授权里的 PR>）`。这样同一个提交出现在两个 PR 里（比如关掉 A 后用同一分支重开成 B）时，A 的授权不会让 B 合入。没有 `pr:` 的旧格式授权照旧绑定 patch-id，PR 内容一变就报 `authorization: patch_changed`。
## Mivo 车道

`xindong/mivo-canvas-plugin` 的 main 保留「只有名单里的人能更新」限制（`main-merge-allowlist` 与分支保护推送名单），不开合并队列：合并队列的机器人不在名单里，会被拒（2026-11-06 实测，xindong/mivo-canvas-plugin#1805、#1927）。所以门禁全过后，由 App 直接合并（App 在两份名单里）：

- `PUT /pulls/{n}/merge`，squash，`sha` = 本轮检查的 head。
- **能直接合就直接合，不碰 PR**（2026-11-07 起）：App 看到的 `mergeStateStatus` 是 `CLEAN`、门禁全过时直接合并，即使 PR 落后 main 也不先 `update-branch`。Mivo main 没开 strict，落后的 PR 照样是 `CLEAN`；先追 main 会让 37 项 CI 和审查机在新 head 上白跑一遍（Mivo #1853）。
- 只有 GitHub 要求先同步（开了 strict 的分支，如集成分支，状态是 `BEHIND`）时，才 `update-branch`（带 `expected_head_sha`），等 CI 和审查机在新 head 上重新通过，下一轮再合。
- 已知代价（用户已接受）：PR 和 main 新改动之间的冲突，要合并后 main CI 才能发现（Mivo #1551 那类组合问题）。兜底照旧：合并后 main CI 不成功，车道就暂停；合并提交的父提交对不上检查时的 main，就冻结。
- 一轮只合一个；合完要等 main 新提交上的全部检查都绿，才处理下一个。
- GitHub 拒绝合并（405/409/422）时记 `merge_refused`，PR 留在队列里等下一轮。
- GitHub 的合并接口锁不住 base：从检查到合并的这一刻 main 若被别人推进，合入的组合就和检查时不同。这个窗口关不死（试过对 App 单开 strict：别人被拦下的 PR 会显示 `BEHIND`，审查机当成状态变化反复重审，2026-11-06 已撤）。车道能做的是发现就停：钉住本轮 CI 已确认成功的那个 main 提交（`BEHIND` 时的落后判断也对着它比）；合并后核对合并提交的父提交是不是它，不是就记 `lane_frozen`（`merged_on_moved_main`），读不到合并提交记 `merge_parent_unverified`，合并请求没拿到明确结果（网络错误、5xx）记 `merge_result_unknown`。三种都要人看过 PR 和 main CI 再 `unfreeze`。

每轮先看车道级条件：

- **规则集被改松就冻结车道**：main 上生效的必需检查少于 policy 列出的 8 项，或某项的 integration 不是 15368。冻结后要人工核实，再执行 `unfreeze`。
- **只暂停、不冻结**：main 当前提交不是全绿。每轮开头按顺序看两项，有一项不满足就暂停，条件恢复后自动继续：
  1. 这个提交的 `ci.yml` push run 是 success；不是（还在跑、失败，或还没有 run）时原因是 `main_ci_not_success`。
  2. **全绿才合**（2026-11-08 起，#32）：这个提交上的全部检查都绿，不只看 `ci.yml`（之前 main 上 CodeQL 红着照样合了 #1997）。check run 按写入的 App 和名字分组取最新一次（id 最大；同名检查来自不同 App 时各自算，别的 App 的成功盖不掉这个 App 的失败），必须是 completed 且结论是 `success`、`skipped` 或 `neutral`；commit status 有条目时，合并状态必须是 `success`（没有条目不算不绿）；一个 check run 都没有也不算绿。check run 读完全部分页，读取失败或读不全都按不绿。不满足时原因是 `main_checks_not_green: <提交> <检查名=状态>`，失败的排在还没跑完的前面，最多列 10 个。
- 暂停时不合并、不 `update-branch`、不入队。原因变了才再发一次 `lane_paused`（叫醒伙伴），原因不变的后续轮次不重复发。先看 `ci.yml` 再看全部检查，CI 跑着的那段时间原因保持 `main_ci_not_success` 不变，不会因为检查陆续跑完反复叫醒伙伴。
- **恢复时机**：main 转全绿后的下一轮巡检（脚本调度每 1 分钟一轮，最多约 1 分钟）发 `lane_resumed`，同一轮接着处理队列。
- **已知代价**：main 上任何一项检查长期红（包括非必需检查，以及 GitHub 下载 CodeQL 包 504 这类外部故障），车道就一直暂停，伙伴会收到 `lane_paused`；要人去重跑或修好那项检查，车道才会恢复。
- 集成分支（`integration/*`）的 PR 用同一条全绿规则检查该集成分支的头，不满足只让合进它的 PR 留在队列（原因 `base_checks_not_green: <分支> <提交> <检查名=状态>`），不暂停整条车道，main 的 PR 照常合。

单个 PR 的门禁：作者是 `PraiseZhu` 或 `praise-qa[bot]`；自动接单的条目还要 PR 当前仍带接单时的标签（见下一节）；授权没过期；不是 Draft；base 是 `main`；8 项必需检查在 head 上全部通过，且都由 integration 15368 写入；没有未解决的讨论；App 看到的 `mergeStateStatus` 是 `CLEAN`。有 `after` 依赖的 PR，要等依赖真正合进 main 才处理。

## 自动接单（praise-qa[bot] 的 Mivo PR）

2026-11-08 用户定：praise-qa bot 开的 Mivo 修复 PR 满足标准就自动合，不用用户说「合并」；PraiseZhu 本人的 Mivo PR 照旧由用户说「合并」交单。审查机已定 praise-qa App 开的 PR 与 PraiseZhu 本人同权（PraiseZhu/Review-PR#223）。policy 的 Mivo 条目上写：

```json
"auto_intake": { "authors": ["praise-qa[bot]"], "label": "review:merge-ready", "base": "main", "label_actors": ["praisebuild[bot]", "PraiseZhu"] }
```

- **只能写在 `lane: mivo` 的条目上**：写在个人仓条目或 `PraiseZhu/*` 通配条目上，加载配置时报错，错误信息带条目名。`authors` 只能是 Mivo 车道名单里的作者，`base` 只能是 `main` 或 `integration/*`，`label_actors` 至少一项，四项都必须写。
- **接单条件**：每轮处理队列前，用 App 令牌只读列一次这个仓 open 的 PR（一轮一次列表请求，不翻页，按更新时间倒序取 100 个；取满 100 个时日志记一条 `auto_intake_page_full`），全部满足才接：open、非 Draft、作者在 `auto_intake.authors` 里、base 等于 `auto_intake.base`、带 `auto_intake.label` 标签，且这个标签是 `label_actors` 里的账号挂的（见下一条）。
- **标签必须是审查机挂的**（2026-11-08 起）：只有 Triage 权限的人补挂标签，不能触发有合并权限的 App；审查机在核对员推翻全部卡点时会把 `review-pr` 写绿、但故意不挂标签，要人工看。所以对其余条件都满足的 PR，再用 `GET /repos/{repo}/issues/{n}/events` 读完全部分页（最多 10 页），找这个标签最近一次 `labeled` 事件，操作者必须在 `label_actors` 里（审查机挂标签的身份是 `praisebuild[bot]`，写入关闭时退回 `PraiseZhu`）。读不到、分页没读完、没有 `labeled` 事件、操作者不在名单，都按不满足：接单时不接，已在队列的处理时不合，原因 `auto_intake_label_actor`。操作者不对只记日志（`auto_intake_skipped`）；读不到算出错，见「接单出错」。
- **接单记录**：`session_id` 是 `auto-intake`，`authorization_text` 是「2026-11-08 用户定：praise-qa bot 的 Mivo PR 满足标准自动合」，授权时间是接单时间（照样 7 天有效）。每接一个 PR 产生一条 `auto_intake` 事件，叫醒伙伴通知用户。
- **不重复接单**：队列里这个 PR 已有未完成的条目时跳过；已 `merged` / `closed` 的跳过；`expired` 的重新接单；`dequeued` / `rejected` / `blocked_by_dependency` 的只有 head 变了（当前 head 不在这条记录见过的 head 里）才重新接单。
- **标签被摘掉就不合**：自动接单的条目处理时还要求 PR 当前仍带接单时的标签；审查机摘掉标签后不合，留在队列里等，原因 `auto_intake_label_missing`。写合并请求前重读 PR 时也再查一次标签。用户说「合并」接的条目不查标签。
- **门禁不放松**：必需检查和写入方、讨论全部解决、`mergeStateStatus`、Draft、base、main CI 成功才合下一个，一条不少。
- **接单出错不中断本轮**：列表请求失败（5xx、限流）、接单时读不到标签操作者，或已在队列的自动接单条目处理时读不到标签操作者（条目照旧不合），都照常处理队列里已有的条目，本轮最后合成一条原因，记一条 `auto_intake_failed`（叫醒伙伴）。原因按 PR 号排序，列表换了顺序不算原因变了。同一原因接着失败只记日志 `auto_intake_still_failing`，不再叫醒；恢复时记一条 `auto_intake_recovered`（叫醒伙伴）。已入队条目这一轮没轮到处理时沿用上次的结果，不算恢复。
- Mivo 车道冻结时不列 PR、不接单，解冻后下一轮再接。

## 安全开关

- **影子模式**：`app.json` 里的 `shadow` 默认为 true。这时引擎只记录 `would_merge`、`would_update_branch` 和 `would_enqueue`（Mivo main 开着合并队列时）；自动接单照常写进队列，但事件记成 `would_auto_intake`，不叫醒伙伴，任何写请求在发出前就会被拒绝。只有显式写 `"shadow": false` 才会真的合并。
- **停止开关**：存在 `$PRAISE_MERGE_STATE/DISABLED` 文件时，`tick` 不发任何请求。这个检查先于读取配置，所以配置坏了开关照样有效。
- 日志在 `$PRAISE_MERGE_STATE/logs/events-YYYY-MM-DD.jsonl`。

## 部署与运维

Mini 上的部署、Cindy 定时任务、合并伙伴、影子模式切换、停止与回滚：见 [docs/operations.md](docs/operations.md)。

## 开发

```sh
npm test
```

测试里用的私钥在运行时现生成。仓里不放 PEM、安装令牌或 JWT 形态的字面量，`tests/no-secrets.test.mjs` 和 CI 会检查。

门禁和车道按目录自动加载：在 `src/gates/` 或 `src/lanes/` 下加一个文件就能注册，不用改 `index.mjs`。
