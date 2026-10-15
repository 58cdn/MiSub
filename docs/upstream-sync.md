# 上游同步

`sync-upstream.yml` 每天北京时间 08:00（UTC 00:00）检查 `imzyb/MiSub:main`，也支持在 main 上手动运行。GitHub 定时任务可能延迟。只有这一个同步入口。

## 候选更新

- 以上游提交是否已经是 main 的祖先判断更新；二开独有提交不会被当作上游更新。
- 使用 `automation/upstream-sync` 和一个指向 main 的 PR。首次创建 Draft PR，后续更新同一个 PR。合并 main 和上游时保留历史与二开，不向 main 推送，不强推远端分支。
- 上游和 main 均已包含在现有候选时，每日检查跳过推送与测试。main 前进时刷新现有候选；手动运行可重试失败、取消或中断的验证。
- 冲突发生时中止本次合并，在 Actions 日志及 Summary 记录 main、上游 SHA 和冲突路径，不推送冲突结果。人工在同步分支解决后手动重试。未合并分支失去 PR、重复 PR、无权限及非快进推送均失败退出，禁止自动重置恢复。
- `concurrency` 串行处理每日及手动运行，普通推送拒绝外部并发修改。已合并且保留的同步分支只能在其历史属于 main 时复用。建议使用 merge commit 合并同步 PR；squash/rebase 会丢失上游祖先关系，应由维护者处理分支历史，不能强推 main。

## 测试与审查门禁

准备 job 只执行工作流检出的可信脚本。独立的只读 validate job 检出完整候选 SHA，确认候选含固定 main SHA，再执行同步场景、部署脚本、测试门禁自测、完整 Vitest discovery/completion gate 和构建。Windows 只读 job 对相同候选执行同步场景及完整 Vitest gate，覆盖 Linux 明确列为平台跳过的 Windows 原生用例；两端都成功才允许发布成功状态。候选已经合并该 main，因此它的树就是该 base 与 head 的合并结果；不将 main 工作流自身的成功误当成候选验证成功。完成证据以候选 SHA 和平台命名保留在 Actions artifacts。

publish job 重新检出可信工作流 SHA，不执行候选代码；仅在 Linux 与 Windows 校验均完整成功、PR head 和 main base 未变时，向该候选 SHA 发布 `upstream-sync/validated-merge=success`。失败、取消、跳过和过期均不能发布成功；准备后中断可能保留 pending，需要手动重跑。PR 正文的 pending 是指向实时状态的提示，不是测试报告。

GitHub 对 GITHUB_TOKEN 创建或更新 PR 的工作流触发有限制；当前文档说明部分 PR 事件可能等待有写权限的用户批准。本流程直接在同一次运行执行候选验证，不依赖 PR 事件自动运行。无需 PAT、App 私钥或 `actions:write`。仓库须允许 Actions 创建 PR；若未允许，会显式失败，保留分支供恢复，不更换身份重试。

正式使用前，管理员须确认 main 的分支保护或 ruleset：

1. 必须通过 PR 合并，并要求至少一名审查者批准；新提交撤销过期审查。
2. 必需检查使用现有 Cloudflare Pages 的 `Test, build and deploy`（适用于所有 main PR），并启用严格的“Require branches to be up to date before merging”。该原生 PR 检查必须在当前合并结果上真实执行成功；机器人 PR 若待批准，由维护者先批准运行。状态发布后 main 仍可能前进，严格门禁负责阻止旧 base 的成功结果被合并。
3. 同步 PR 还须人工核对 `upstream-sync/validated-merge` 对应候选 SHA、base SHA 与测试证据。该附加状态仅由同步流程发布，不应设为所有 PR 的全局必需状态，否则普通 PR 将无法满足。不得把未启动、待批准或被跳过的运行当作通过。

本工作流不修改分支保护、不设置自动合并、不批准自身 PR。Draft PR 必须在测试及人工审查通过后由维护者转为 ready 并合并。无法读取或验证上述仓库设置时，应视为上线验收阻塞，不能声称服务器门禁已生效。

## 部署

同步准备和验证均没有 Cloudflare 凭据，不调用部署脚本或 dispatch 部署。现有 `cloudflare-pages.yml` 在 main 的 push 或显式 dispatch 时会测试、构建并部署；人工合并 PR 通常会产生 main push，届时沿用该行为。PR 阶段该工作流只测试与构建。不要为试运行同步而提前合入未验收的上游提交。

## 离线验证

```sh
node --test tests/upstream-sync/*.test.mjs
npm run test:gates
node --test tests/deployment/*.test.mjs
npm run test:ci
npm run build
```

同步测试使用临时本地 Git 仓库及模拟 GitHub API，不访问或合并真实上游。覆盖二开领先无更新、分叉、单一 Draft PR、已有 PR 增量更新、base 更新、无变化跳过、冲突、重复 PR、孤立分支、并发推送、权限失败、取消/跳过以及过期结果拒绝。

参考：[工作流触发与 GITHUB_TOKEN](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)、[受保护分支与严格检查](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)。
