# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
