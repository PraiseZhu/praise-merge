# praise-merge

用 GitHub App `praise-merge` 按各仓的合并标准，自动合并 PraiseZhu 负责的 PR。总 issue：PraiseZhu/praise-merge#1。项目约定见 [CLAUDE.md](./CLAUDE.md)，版本管理见 [VERSIONING.md](./VERSIONING.md)。

能不能合由本仓的脚本逐项判断，不交给模型。合并只用 App 令牌，失败就停下报错，不改用个人账号，也不调用 `gh`。

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
    { "repo": "PraiseZhu/project-keel", "number": 12, "head_sha_at_auth": "0123456789abcdef0123456789abcdef01234567" },
    { "repo": "PraiseZhu/project-keel", "number": 13, "head_sha_at_auth": "89abcdef0123456789abcdef0123456789abcdef", "after": ["PraiseZhu/project-keel#12"] }
  ]
}
```

- `after`：要等这些 PR 合进去之后才合。成环时整份请求拒收。
- 授权有效期 7 天，从 `authorized_at` 算起，过期还没合的 PR 退回。
- 入队时用 App 只读确认：作者必须是 `PraiseZhu`，PR 必须是 open 状态。
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
| `up_to_date` | head 已包含最新 base |
| `mergeable_clean` | App 看到的 `mergeable_state` 是 `clean` |
| `evidence` | 三样证据：PraiseZhu 的合并授权（7 天有效）与 GPT 单审必须有；policy 里 `e2e` 为 `required` 时 e2e 也必须有（见下一节） |

- 只差 `up_to_date`（以及随它变化的 `required_checks`、`mergeable_clean`）时，引擎调用 `update-branch` 替 PR 追上 base，等新 head 的 CI 跑完再判断。
- 合并命令带 `sha` = 本轮检查时读到的 head：检查之后有人推送，合并就会失败。
- 同一仓一次只合一个 PR。合并后要等 base 分支的 CI 出结论，才会合下一个；base 的 CI 红了，车道就冻结，直到执行 `unfreeze`。

## policy：逐仓条目与 `PraiseZhu/*` 默认条目

`policy.json` 的 `repos` 里可以写一个 `PraiseZhu/*` 默认条目（2026-11-07 起）。没有逐仓条目的 PraiseZhu 仓（含 fork、以后新建的仓）都按它接单和判断，不用再逐个加仓：

```json
"PraiseZhu/*": { "lane": "personal", "required_checks": "all", "e2e": "required", "merge_method": "squash" }
```

- **优先级**：逐仓条目优先；没有逐仓条目才用默认条目；两者都没有就拒收（`repo_not_in_policy`）。`makecindy/cindy`、`xindong/mivo-canvas`、`xindong/XDMaker` 照旧一律拒收（`repo_excluded`）。
- **只限个人仓车道**：默认条目的 `lane` 只能是 `personal`，`e2e` 只能是 `required`（不写也按 `required`）。别的 owner 的通配条目（如 `xindong/*`）、`lane` 为 `mivo` 的通配条目，加载配置时直接报错，错误信息带条目名。
- **`"required_checks": "all"`**：当前 head 上除 `praise-merge/*` 证据 status 以外的全部 check run 和 commit status 都要通过；有一项失败或还在跑就不合，原因列出 `名字=状态`。逐仓的 `personal` 条目也可以这样写，`mivo` 车道不行。
- **一项检查都没有时**：可能是 CI 还没出现。head 提交推送到 PR 分支（按仓库活动接口里的推送时间）满 10 分钟才放行；不满 10 分钟就留在队列，原因写「head 上还没有任何检查，等 CI 出现」。读不到推送时间也不合。
- 门槛不比逐仓条目低：三样证据、作者、非 Draft、默认分支、讨论全解决、不落后、`mergeable_state=clean` 全部照旧。

## 审查证据

个人仓的合并条件是三样证据都在：你的合并授权、GPT 单审通过、e2e 通过（e2e 为 `required` 时；2026-11-06 起 11 个个人仓都是）。证据是写在 PR head 上的 commit status。用户在会话里说「合并」时，`pr-merge` skill 写授权证据，并把本会话已有的 GPT 单审、e2e 结论写成证据（没有结论就不写，PR 不会被合）。手动写用：

```sh
bin/praise-merge attest --repo PraiseZhu/project-keel --pr 12 --head <审查实际看的 40 位 SHA> \
  --kind gpt-review --result pass --by gpt-5.5
```

- `attest` 是唯一调用 `gh` 的命令，用的是调用者本机的 PraiseZhu 登录。它不碰 App 私钥。
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
- Mivo 没开 strict，合并前 PR 必须不落后 main。落后就先 `update-branch`（带 `expected_head_sha`），等 CI 和审查机在新 head 上重新通过，下一轮再合。
- 一轮只合一个；合完要等 main 新提交的 CI 成功，才处理下一个。
- GitHub 拒绝合并（405/409/422）时记 `merge_refused`，PR 留在队列里等下一轮。
- GitHub 的合并接口锁不住 base：从检查到合并的这一刻 main 若被别人推进，合入的组合就没测过。这个窗口关不死（试过对 App 单开 strict：别人被拦下的 PR 会显示 `BEHIND`，审查机当成状态变化反复重审，2026-11-06 已撤）。车道能做的是发现就停：用本轮 CI 已确认成功的那个 main 提交做落后判断；合并后核对合并提交的父提交是不是它，不是就记 `lane_frozen`（`merged_on_moved_main`），读不到合并提交记 `merge_parent_unverified`，合并请求没拿到明确结果（网络错误、5xx）记 `merge_result_unknown`。三种都要人看过 PR 和 main CI 再 `unfreeze`。

每轮先看车道级条件：

- **规则集被改松就冻结车道**：main 上生效的必需检查少于 policy 列出的 8 项，或某项的 integration 不是 15368。冻结后要人工核实，再执行 `unfreeze`。
- **只暂停、不冻结**：main 当前 head 的 `ci.yml` 不是 success（还在跑、失败，或还没有 run）。条件恢复后自动继续。

单个 PR 的门禁：作者是 `PraiseZhu`；授权没过期；不是 Draft；base 是 `main`；8 项必需检查在 head 上全部通过，且都由 integration 15368 写入；没有未解决的讨论；App 看到的 `mergeStateStatus` 是 `CLEAN`。有 `after` 依赖的 PR，要等依赖真正合进 main 才处理。

## 安全开关

- **影子模式**：`app.json` 里的 `shadow` 默认为 true。这时引擎只记录 `would_merge`、`would_update_branch` 和 `would_enqueue`（Mivo main 开着合并队列时），任何写请求在发出前就会被拒绝。只有显式写 `"shadow": false` 才会真的合并。
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
