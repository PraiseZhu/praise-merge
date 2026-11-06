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
| 模型 | 低价模型（与「Mini-扫地僧」相同），只用来跑命令和转述结果 |
| 关联项目 | Project PraiseMerge |
| 例行任务 | 「合并引擎巡检」：每 10 分钟一轮；没有要人看的事件就安静结束 |
| skill 投递地址 | live skill 目录 `pr-merge/partner.json` 里写的是伙伴主聊天的会话 id |

例行任务每轮做的事：
1. 执行 `PRAISE_MERGE_CONFIG=~/praise-merge-runtime/config node ~/praise-merge-runtime/bin/praise-merge tick`。
2. 读输出里的 events。只有出现要人看的事件时才通知用户：合入、入队、移出队列、过期、拒收、冻结、暂停。影子记录（`would_*`）不通知。
3. 命令报错时，再跑一次 `doctor`，把两段输出一起报给用户。

`scripts/cindy-tick.mjs`（以及它写的 `state/heartbeat.json`、健康告警）只属于 Cindy script 模式的零 token 入口，现在不用。例行任务直接跑 `praise-merge tick`，它的运行记录看伙伴设置里的 Run History。

## 合并伙伴怎么工作

伙伴的人设里写着：每次处理前先读本节，以本节为准。

### 收到「praise-merge 合并请求」

消息由 skill「合并」发来：第一行是 `praise-merge 合并请求`，后面是一个 JSON 代码块。

1. 把 JSON 原样写进 `~/.local/state/praise-merge/requests/<时间戳>.json`。
2. 执行 `node ~/praise-merge-runtime/bin/praise-merge enqueue --file <那个文件>`，配置目录用 `PRAISE_MERGE_CONFIG=~/praise-merge-runtime/config`。
3. 把输出里的 `accepted`、`rejected` 回复给用户，每个 PR 一行，带链接。

不改请求内容，不替用户补 PR，也不自己合并任何 PR。

### 例行任务发现事件时

按事件类型回复用户：

| 事件 | 回复 |
|---|---|
| `merged` / `enqueued` | 一句话：哪个 PR 合入了，或者进了合并队列 |
| `dequeued` / `merge_refused` | PR 号和原因，提醒用户看 CI 或冲突 |
| `expired` / `blocked_by_dependency` / `rejected` / `closed` | PR 号和原因：这个 PR 已退回给用户，需要的话重新说「合并」 |
| `lane_frozen` | **醒目提示**：哪个仓的车道冻结了、原因是什么。确认没问题后，执行 `praise-merge unfreeze <owner/repo>` |
| `lane_paused` / `lane_resumed` | 一句话说明原因 |
| `health_alert` | **醒目提示**：心跳中断或连续失败。附上 `doctor` 的输出 |

要看现状时，执行 `praise-merge status`。

## 影子模式与真实合并

`config/app.json` 里 `"shadow": true` 是影子模式：照常判断，但只记录 `would_merge`、`would_update_branch`、`would_enqueue`，不发任何写请求。

打开真实合并之前，以下三件事都要先满足：
1. 影子运行满 7 天。
2. 每条 `would_*` 都和人工合并的结果一致，并且没有出现过「本来会合并」但实际不该合的 PR。
3. Mivo 规则集已经打开合并队列，并给 App 加了豁免（只限 pull request）。

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
