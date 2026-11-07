# 运维手册

合并引擎跑在 Mini 上。一共三样东西：

| 东西 | 在哪 | 作用 |
|---|---|---|
| 运行目录 | `~/praise-merge-runtime/`（不在 Syncthing 同步目录里） | 代码 + 真实配置 `config/app.json`、`config/policy.json` |
| 状态目录 | `~/.local/state/praise-merge/` | 队列、车道、心跳、日志、停止开关 |
| 私钥 | `~/.config/mivo-github-apps/praise-merge.pem`（600） | App `praise-merge`（ID 5642127）的私钥，只在 Mini 上 |

Cindy 里还有一个伙伴「合并伙伴」（主力电脑 Mini）。它用自己的例行任务定时跑引擎，也负责接收合并请求和通知用户。

## 部署与更新

```sh
cd <本仓>
scripts/deploy.sh                 # 演练：列出会改什么
scripts/deploy.sh --apply         # 真的拷到 ~/praise-merge-runtime/
node ~/praise-merge-runtime/scripts/doctor.mjs --config ~/praise-merge-runtime/config
```

- `deploy.sh` 不会覆盖运行目录里的 `config/app.json`、`config/policy.json`，也不碰 `state/`、`DISABLED`。
- 正在跑的一轮不受影响，下一轮起就用新代码。
- `doctor` 必须全部 pass 才算部署完成。它检查：私钥存在且权限是 600、私钥不在 `~/AI-Agent` 下、两个安装都能换到令牌、令牌权限与期望的 8 项完全一致、policy 里的仓都在安装范围内。

## 合并伙伴（Cindy 伙伴）

| 项 | 取值 |
|---|---|
| 伙伴 | 「合并伙伴」，botId `bot_1793971930675_jl0cwg`，主力电脑 Mini |
| 模型 | 主模型 `deepseek/deepseek-v4.1-flash`（Pi，档位 medium）；备用 `claude-sonnet-5-5`（档位 medium），主模型不可用时自动接上。理由：工作只是跑命令、转述结果；2026-11-06 实测主模型每轮巡检约 $0.005、4 秒，入队和巡检都按手册做对了 |
| 关联项目 | Project PraiseMerge |
| 例行任务 | 三条，见下表 |
| skill 投递地址 | live skill 目录 `pr-merge/partner.json` 里写的是伙伴主聊天的会话 id |

### 例行任务

三条都只跑脚本、转述结果，不让模型自己去 GitHub 查数据。命令都在 `~/praise-merge-runtime` 下执行，带上 `PRAISE_MERGE_CONFIG=~/praise-merge-runtime/config`。

| 例行任务 | 触发 | 跑什么 | 什么时候通知用户 |
|---|---|---|---|
| 合并引擎巡检 | 每 10 分钟 | `node bin/praise-merge tick` | 输出里出现要人看的事件时（合入、入队、移出队列、过期、拒收、冻结、暂停）。只有 `would_*` 或没有事件时安静结束。命令报错时，跑 `node scripts/doctor.mjs` 一起报 |
| 影子对账日报 | 每天 21:30 | `node scripts/shadow-report.mjs` | 每天都发：原样转述脚本输出。第一行带 ⚠️ 时放在最前面醒目提示 |
| 每日自检 | 每天 09:00 | `node scripts/daily-check.mjs` | 输出 `ok` 时安静结束；否则逐条转述 |

`scripts/cindy-tick.mjs`（以及它写的 `state/heartbeat.json`、健康告警）只属于 Cindy script 模式的零 token 入口，现在不用。例行任务直接跑 `praise-merge tick`，它的运行记录看伙伴设置里的 Run History。

## 合并伙伴怎么工作

伙伴的人设里写着：每次处理前先读本节，以本节为准。

### 收到「praise-merge 合并请求」

消息由 skill「合并」发来：第一行是 `praise-merge 合并请求`，后面是一个 JSON 代码块。

1. 把 JSON 原样写进 `~/.local/state/praise-merge/requests/<时间戳>.json`。
2. 执行 `node ~/praise-merge-runtime/bin/praise-merge enqueue --file <那个文件>`，配置目录用 `PRAISE_MERGE_CONFIG=~/praise-merge-runtime/config`。
3. 把输出里的 `accepted`、`rejected` 回复给用户，每个 PR 一行，带链接。

不改请求内容，不替用户补 PR，也不自己合并任何 PR。

### 哪些仓能接单（2026-11-07 起）

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
| 分支头 CI | main 当前头的 `ci.yml` push run 成功，不成功就暂停整条车道 | 该集成分支当前头的 `ci.yml` push run 成功，不成功只让这个 PR 留在队列（`base_ci_not_success`），不挡 main 的 PR |
| PR 自身 | 作者 PraiseZhu、非 Draft、当前 head 的必需检查全过（写入方是 integration 15368）、讨论全解决、合并状态 CLEAN | 同左，审查检查换成 `review-pr (integration)` |
| 落后时 | `update-branch` 追 main | `update-branch` 追该集成分支，对着该分支本轮钉住的头比 |
| 合并 | squash，锁定检查过的 head | merge（最近 5 个合进集成分支的 PR 3 个用 merge；squash 会丢同步 main 的祖先关系），锁定检查过的 head |
| 合并后核对 | 合并提交唯一的父提交是检查时的 main 头，对不上就冻结（`merged_on_moved_main`） | 合并提交的父提交是检查时的集成分支头和 PR head，对不上就冻结（`merged_on_moved_base`） |

冻结范围不变：只冻结 Mivo 车道。main 和各集成分支的头分开记在车道状态里（`checkedMainSha`、`checkedBaseShas`），一个分支前进不会让另一个分支的 PR 被误判。main 的 CI 不成功时整条车道暂停，集成分支的 PR 也一起等。

### 例行任务发现事件时

按事件类型回复用户：

| 事件 | 回复 |
|---|---|
| `merged` / `enqueued` | 一句话：哪个 PR 合入了，或者进了合并队列 |
| `dequeued` / `merge_refused` | PR 号和原因，提醒用户看 CI 或冲突 |
| `expired` / `blocked_by_dependency` / `rejected` / `closed` | PR 号和原因：这个 PR 已退回给用户，需要的话重新说「合并」 |
| `lane_frozen` | **醒目提示**：哪个仓的车道冻结了、原因是什么。原因是 `merged_on_moved_main` / `merged_on_moved_base` / `merge_parent_unverified` / `merge_result_unknown` 时，附上 PR 链接和目标分支（main 或原因里写的集成分支）最新一次 `ci.yml` 的结论；用户确认没问题后，执行 `praise-merge unfreeze <owner/repo>` |
| `lane_paused` / `lane_resumed` | 一句话说明原因 |
| `health_alert` | **醒目提示**：心跳中断或连续失败。附上 `doctor` 的输出 |

要看现状时，执行 `praise-merge status`。

### 合入后通知发起合并的会话（2026-11-07 起）

`merged` 事件除了告诉用户，还要通知发起这次合并的会话：「批准执行」的 lead 收到通知才会派下一批（用户 2026-11-07 定）。合并请求里的 `notify_session` 就是这个会话的地址（`<deviceId>::<会话 id>`），伙伴把请求原样存在 `requests/` 下。对每条 `merged` 事件：

1. 查通知地址，把 `<owner/repo>` `<号>` 换成事件里的 `repo` 和 `pr`：

   ```sh
   node -e 'const fs=require("fs"),p=require("path");const d=p.join(process.env.PRAISE_MERGE_STATE||p.join(require("os").homedir(),".local/state/praise-merge"),"requests");const [r,n]=process.argv.slice(1);const files=fs.existsSync(d)?fs.readdirSync(d).filter(f=>f.endsWith(".json")).map(f=>p.join(d,f)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs):[];for(const f of files){let q;try{q=JSON.parse(fs.readFileSync(f,"utf8"))}catch{continue}if((q.prs||[]).some(x=>String(x.repo).toLowerCase()===String(r).toLowerCase()&&Number(x.number)===Number(n))){if(q.notify_session)console.log(q.notify_session);break}}' <owner/repo> <号>
   ```

   只看最新一份包含这个 PR 的请求：它带 `notify_session` 就输出，不带就输出为空（不通知），不回退去用更旧请求里的地址。
2. 有地址就用 Cindy 的 `send_to_session` 发给它（`target_session_id` 填这个地址），正文只有一行：`praise-merge 已合并 <owner/repo>#<号>`。
3. 回执是 `REMOTE_DEVICE_OFFLINE` / `REMOTE_DISABLED` / `REMOTE_UNAVAILABLE`：给用户的回复里加一句「没通知到发起合并的会话，请在那个会话里说『继续』」。`DELIVERY_UNKNOWN`：先用 `get_chat_history` 查对方收到没有，确认没收到再重发一次。

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
- **停例行任务**：在合并伙伴的设置 → Routines 里暂停「合并引擎巡检」。
- **轮换私钥**：在 GitHub App 设置里生成新私钥，替换 Mini 上的 pem 文件（权限 600），跑一次 `doctor`，然后删掉旧私钥。

## 看日志

```sh
tail -n 50 ~/.local/state/praise-merge/logs/events-$(date +%F).jsonl
node ~/praise-merge-runtime/bin/praise-merge status
```

## 已知限制

- 例行任务彻底停了时，没有一轮能去发告警。这时要看合并伙伴设置里例行任务的 Run History。
- `mergeable_state` / `mergeStateStatus` 是按 App 自己的身份读的。影子期间要和 PraiseZhu 看到的值对一遍，见总 issue「上线后验证」。
