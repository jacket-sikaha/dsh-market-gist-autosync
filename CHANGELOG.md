# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.4] - 2026-09-24

### 修复

- **启动预检漏判「能解析但启动不了」的 bundle**（严重）：0.1.3 的预检只确认包目录存在，而加载器在解析成功后还要读取该包的 `dsh.bundle.patch` 并解析它指名的文件，以下三种情况同样让**整个 profile** 启动失败：未声明 `dsh.bundle.patch`、声明的补丁文件不存在、补丁不是合法的顶层条目数组。这类 bundle 此前会通过预检、留在清单里，用户仍然在下一次重启时进恢复模式 —— 正是预检本该消除的场景。现在三种情况都会判定为致命并移除。
- **恢复提示自相矛盾**：被 `install.ts` 剔除的本地依赖，又被 `operations.ts` 报成「需在插件市场手动重装」—— 同一个依赖先被告知「已剔除」、再被告知「去装它」。现在报告改为读取**安装完成之后**的清单，已剔除的依赖不会再出现在警告里；仍然保留的本地依赖也会如实说明「本机可用，换机器后路径不存在」，而不是让用户去重装一个正常工作的插件。
- 无法自动安装依赖（pnpm 不可用）时，已剔除的本地依赖现在也会在摘要里说明，不再只报告需要重装的插件。
- **GitHub 请求防卡死**（对齐 dshmarket 的 `gistRequest`）：此前 `gistHttp` 用 `req.setTimeout` 单层超时，且 GET 响应不预判 `content-length`。现在每次请求带 `AbortSignal.any([调用方 signal, 30s 硬上限])` 双保险 —— 路由级 signal 优先触发就先终止、30s 兜底保证永不挂起；响应在 `content-length` 头预判 + 流式字节累计双重把关下限制在 1MB+16KB，防止超大响应撑爆内存。`createGist` / `updateGist` / `verifyToken` / `readGistBackupContent` 新增可选 `signal` 参数，调用方暂未传也不影响（走 30s 硬上限）。

### 变更

- **机器本地依赖改为在备份端剥离**（治本，取代此前的恢复端破坏性清理）：`link:C:/Users/...` 这类依赖描述的是某一台机器的磁盘布局，而一个 Gist 会被多台机器读取。此前把它留在备份里，对端恢复时只能剔除该依赖并连带删掉 bundle 记录 —— 把一台机器的局部限制写进共享状态，再被下一次备份带回来。现在上传前就剥离（`stripMachineLocalDeps`），连同引用它们的 bundle 记录；Gist 始终只是「可移植插件组合」的描述。只影响备份副本，**不改写本机 profile**，本机继续正常使用这些本地插件。恢复端保留剔除逻辑，作为对旧版本 / 其它工具写下的备份的兜底。
- 判定范围与 dshmarket 的 `unportableDeps` 一致；`file:./vendor/x` 这类相对路径可移植，保留。

### 新增

- **补丁预检**：按加载器的方言解析补丁（js-yaml 的 JSON schema + `!!js` 标量标签）。社区补丁确实在用 `!!js`（`dsh-better-sidebar`、`@tt-a1i/archify-dsh`），用普通 YAML/JSON 解析器会把它们误判为损坏并**删除**，因此解析器不可用时按**未知**处理、绝不判为致命。
- 备份结果新增 `strippedDeps` / `strippedBundles` 字段并在界面说明被排除的内容，不会静默消失。
- **错误分类**（对齐 dshmarket 的 `GistError` / `GistErrorCode`）：此前失败统一返回粗粒度 `{ok,code,error}`，`code` 只有 `invalid_gist` / `rate_limit` / `network` / `other` 几个，「请求超时」混在 `network` / `other` 里分不清。现在 `classify()` 把 HTTP 状态细分为 `auth`(401) / `not_found`(404) / `rate_limit`(403) / `invalid`(422) / `other`，并新增 `classifyNetError()` 把请求级失败分成 `timeout`（AbortError/TimeoutError）/ `network`（ECONNRESET 等一组码）/ `other`，`failNet()` 据此返回带正确 code + 本地化文案的 `Result`。前端可按 code 精确映射文案，区分「token 失效」「Gist 不存在」「限流」「超时」「网络不可达」。
  - **注意**：旧的 `invalid_gist` code 现拆成 `not_found`(404) + `invalid`(422)；前端若有按 code 匹配文案的硬编码需补这两条分支。

### 测试

- `itest-boot-check.mjs`：新增第 6 组覆盖「能解析但补丁有问题」的四种形态与 `!!js` 对照；夹具改为构造**真实**的 bundle（此前只放一个 `package.json`，而加载器本来就会拒绝这种包，夹具与真实契约不符）。
- 新增 `itest-backup-strip.mjs`（25 项）与 `itest-restore-report.mjs`（9 项）。
- 新增 `gist-hardening-test.mjs`（16 项）：用本地 http server 模拟，验证错误分类（`classify` / `classifyNetError` / `failNet`）、`AbortSignal` 触发 `timeout` code、`content-length` 预判拒绝超大响应、正常响应不受影响。

## [0.1.3] - 2026-09-23

### 修复

- **恢复后不再进恢复模式**（严重）：启动加载器读取 `dsh.profile.bundles` 时，遇到**第一个无法解析的包名就会整个 profile 启动失败**，而且是在**下一次重启**才暴露，错误信息与导致它的恢复操作毫无关联。此前若 Gist 里含有本机装不上的 bundle（典型情况：`link:` 依赖指向另一台机器的路径），恢复会「成功」，重启却直接进恢复模式。现在恢复流程结束前会做启动预检，把仍然无法解析的 bundle 从 profile 移除并明确报告。

### 新增

- **启动预检**（`src/analyze.ts`）：按 dsh 启动加载器的真实解析顺序判定每个 bundle 能否解析 —— 先查 DSH 安装侧（in-box bundle 由 DSH 安装提供，profile 里没有是正常的），再按 Node 的模块查找路径从 profile 目录向上找（覆盖 pnpm workspace 提升）。恢复时报告 `bootErrors`。
- **不可移植依赖的自动剔除**：`link:` / `file:` 依赖若指向本机不存在的路径，恢复时直接从 `package.json` 剔除。这类依赖任何情况下都无法安装，留在清单里只会让引用它的 bundle 无法解析。
- 恢复结果新增 `bootErrors` 字段；设置页恢复提示会说明被移除的 bundle 名称及原因。

### 说明

- 探测失败（锚点不可读）与「包确实不存在」被严格区分：前者按**未知**处理，绝不参与删除。把「我看不到」当成「它不存在」会误判所有 bundle 缺失并全部删除。
- 版本 0.1.2 引入的 `unportableDeps` 检测只**报告**不可移植依赖；本版本进一步**处理**它们。

## [0.1.2] - 2026-09-23

### 新增

- **不可移植依赖检测**（`unportableDeps`，对齐 dshmarket #205）：识别 `link:` / `file:` 形式的本地路径依赖（绝对路径、Windows 盘符路径、UNC 路径），恢复时在 UI 明确警告 —— 这类依赖换一台机器后无法安装，需在插件市场手动重装或移除。

## [0.1.1] - 2026-09-23

### 修复

- **上传记录读写路径分裂**：上传记录改存 dsh-storage 域后，读取路径与写入路径不一致，导致「第一次上传备份没有记录」。修复方式为等待 `storageDomain` 就绪（异步 provision 竞态）+ 双向合并读取。
- **domain 表 schema**：改用 zod 定义，并展开 `keys()` / `entries()` 迭代器。
- **重建 lib 产物**：修复此前 storage 修复未进入构建产物、导致从 GitHub / npm 安装的均为旧版的问题。

### 新增

- **上传记录轮询刷新**：后台定时备份完成后无需重启 DSH 即可看到新记录（5 秒轮询）。

## [0.1.0] - 2026-09-23

### 新增

- 首个版本：把当前 profile 的配置备份到私有 GitHub Gist，支持手动 / 定时备份与合并恢复。
- 备份格式与插件市场（dshmarket）完全兼容，可互相恢复（`dsh-profile-backup` / `version: 0.2`）。
- 合并恢复语义：`package.json` 与现有插件合并（不删除已装插件），其他配置文件覆盖。
- 恢复后自动 `pnpm install` 缺失依赖，带实时进度；依赖全部安装失败时回滚文件写入。
- 多 profile 自动识别（desktopProfiles / `--profile` / `DSH_PROFILE` / 兜底 desktop）。
- 严格备份结构校验（格式、路径安全、无重复路径），上限 256 文件 / 1MB。
- 设置页 UI：Token 独立保存、测试连接、立即备份、恢复进度、上传记录（最近 20 条）、浮动 toast 提示。

[0.1.3]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/releases/tag/v0.1.0
