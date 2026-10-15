# MiSub 主应用 Alpha 版本与验收

主应用产品版固定为 `0.0.1-alpha.N`，标签为 `v0.0.1-alpha.N`。Probe 独立使用 `probe-v0.0.1-alpha.N`，两者各自分配 N。只有用户明确确认全部验收后，才可去掉 alpha 或改变基础版本 `0.0.1`。

普通开发提交沿用产品版，用 `0.0.1-alpha.N.sha.<短SHA>` 区分构建。页面版本详情与 `dist/version.json` 保留实际检出的完整源码 SHA，并单独标记未提交的工作区状态。`MISUB_SOURCE_COMMIT` 如提供必须与 Git HEAD 完全相符；CI 的 PR 合并提交按实际检出的 SHA 记录。源码身份缺失时构建失败，不以环境变量覆盖真实 Git 身份。

产品升级使用完整 SemVer 规则：数字标识按数值比较，`alpha.9 < alpha.10`，构建 SHA 不参与产品排序。更新检查固定使用 `58cdn/MiSub` 的公开 alpha 预发布记录；完整遍历发行分页并隔离主应用/Probe 标签。稳定通道当前不可用，草稿、正式发行、上游标签及非本组件标签不会成为候选。未检查、无发行或请求失败均不显示“已是最新”。旧 `0.1`、`0.2`、`0.3` 系列、历史日期版及上游 `2.7.0` 保持真实身份，迁移单独标记，不按数值判定新旧。

## 分配与发布门槛

新可分发测试版本在发布前读取完整远端标签及发行库存，包含草稿；取本组件已使用的最大 N 加一，首次为 1。禁止重置、回退、复用或删除历史标签、产物与日志。包内基础版本由 `package.json` 记录，首次主应用候选为 alpha.1；只有准备新测试发行时才更新该值和 package-lock 根元数据。

`scripts/app-release-policy.mjs` 接受库存 JSON（`productVersion`、`sourceCommit`、`mainCommit`、`tags`、`releases`、`inventoryComplete:true`、`sourceState:clean`），生成独立发行计划：固定源码、`prerelease:true`、`make_latest:false`、草稿、分发暂停、验收待完成。输入库存需包含所有分页；计划本身不验证远端事实、不创建标签或发布。执行发布者在创建前必须重新读取库存及 main 并重跑预检；如序号被占用则重新分配，不能覆盖。

实际打包前将 N 提交到主应用版本元数据；从干净的固定 main SHA 设置 `MISUB_RELEASE_BUILD=true` 构建，发布候选身份与包内 `version.json` 必须一致。开发构建默认包含 SHA，不增加 N。`.github/workflows/misub-alpha.yml` 以只读权限执行回归和构建，上传构建身份，不进行发行或部署。

## Probe 页面合同

历史结果的 `wrapperVersion` 是产品版本，`wrapperRevision` 是当次完整源码 SHA。可选 `buildChannel` 为 `development` / `testing`，`sourceState` 为 `clean` / `dirty` / `unknown`。仅完整且干净的开发声明派生 `.sha.<SHA前12位>`。历史缺字段记录仍可读，不由检测器当前状态补齐；声明是客户端报告，不证明内核执行或验收通过。

Alpha 下载目录在原字段外要求 `channel:testing`、`prerelease:true`。历史目录资产身份继续可读，但不能作为新安装推荐。`distributionReady` 仍为真实全链路验收后的独立门槛；版本比较、CI 成功和生成 Release 都不自动开启它。

## 验证与未验收事项

- 运行 `npx vitest run tests/unit/product-version.test.js tests/unit/app-version-store.test.js tests/unit/app-release-proxy.test.js tests/unit/probe-alpha-compat.test.js`，覆盖 SemVer、命名空间、旧线迁移、源码一致性、预发布筛选与元数据兼容。
- 运行全量 `npm run test:ci`、`npm run test:probes` 与 `npm run build`，记录固定 HEAD 和摘要。
- PR Actions 必须真实执行并成功后才算 CI 通过；零检查或未启动不算通过。
- 实际发行的安装、配对、任务领取、检测、回传和页面检查需要独立证据。当前实现和离线测试不代表该链路验收通过，推荐入口继续受目录门槛控制。
