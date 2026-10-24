# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.13] - 2026-10-25

### 变更

- **备份跳过整个隐藏目录，不再按文件挑日志**：遍历 profile 时所有以 `.` 开头的目录都跳过 —— `.plugin-manager`（宿主的 pnpm 安装日志与进程记录）、`.dsh-market` 缓存、`.git` 等。隐藏**文件**（`.env`、`.npmrc`）照旧备份，它们是真正的配置。规则与 dshmarket 1.70.1+ 的 `profileFiles` 完全一致（上游为 issue #972 改成跳过隐藏目录），所以两边产出的备份仍然互认。
- **移除 `includePluginLogs` 开关**：既然隐藏目录整体不收，就没有"要不要带日志"这个选项了，配置项、RPC 入参、UI 开关一并删除。旧 `config.json` 里残留的 `includePluginLogs` 与 `includeLock` 会在读取时丢弃，不随每次保存继续流传。
- 收集侧不再需要 `.plugin-manager` 的专项分支：`SESSION_LOCAL_DIR` / `SESSION_LOCAL_LOGS` 删除，只保留 `SESSION_LOCAL_RECORD`（`run.json`，恢复旧备份时仍要跳过它）。
- `collectProfileBackup()` / `previewProfileBackup()` 不再接受参数，返回值去掉 `pluginLogBytes`、预览条目去掉 `pluginLog` 标记：备份内容现在没有任何可配置项。
- 超限报错改为始终点名占用最大的几个文件（之前优先说"其中多少是日志"）。

### 界面

- 「查看备份内容」弹窗改名为**「备份内容展示」**：标题、正文说明一并更新，去掉日志标签与"开关"相关文案；底部改为「共 N 个文件 · 合计 X / 上限 Y · 余量 Z」。
- 弹窗把「次要」分组换成**「备份插件列表」**：左边插件名、右边 `package.json` 声明的版本约束（`^1.70.1` 原样显示，恢复时 `pnpm install` 解析的就是它）。插件集合取 `dsh.profile.bundles`，宿主自带的 bundle 没有依赖行，版本显示 `—`；非 bundle 的依赖不列出。真正的非主要配置存在时，「次要」分组仍会出现。
- 设置页删掉「备份里附带插件安装日志」开关及其两段说明，说明文字只留一行：`不含 node_modules、pnpm-lock.yaml、*.bak、符号链接与隐藏目录`，右侧是「查看备份内容」按钮。
- 「保存设置」不再涉及备份内容（已无可配项），仍一次带全 Token、Gist ID、设备名与定时设置。

### 新增

- `scripts/itest-hidden-dirs.mjs`（26 项）：隐藏目录（`.plugin-manager` / 缓存 / `.dsh-market`）整体不收、隐藏文件 `.env` 保留、`*.bak` 与 `pnpm-lock.yaml`、`node_modules` 跳过；预览与收集完全一致；旧 `config.json` 的 `includePluginLogs` / `includeLock` 被丢弃；恢复仍接受带日志的旧备份、写入日志但跳过 `run.json`。

### 修复

- **恢复时的依赖安装不再被 pnpm 的 frozen-lockfile 挡住**：备份从不包含 `pnpm-lock.yaml`（按设计跳过），恢复写下的 `package.json` 描述的是一套新的依赖，profile 里旧 lockfile 必然对不上；宿主又用 `CI=true` 启动子进程，pnpm 在 CI 下默认 `--frozen-lockfile`，于是 `pnpm install` 在装任何东西之前就报 `ERR_PNPM_OUTDATED_LOCKFILE` 失败。现在快路径显式带 `--no-frozen-lockfile`（同一 profile 实测：不加 flag 立刻失败，加了 2.4 s 完成），不再退化到逐个 `pnpm add`。
- 备份侧不再可能生成"对端会静默丢弃一半内容"的备份：dshmarket 1.70.1+ 的 `validatedBackup` 会 `continue` 掉任何含隐藏目录段的条目，旧的"打开日志开关"备份在它那边恢复会显示成功却丢掉日志。

## [0.1.12] - 2026-10-22

### 变更

- **新增 `includePluginLogs` 开关（默认关）：备份默认不再带 DSH 宿主的插件安装日志**。`.plugin-manager/logs/operation-*/pnpm.log` 是宿主为每次包操作写的 `pnpm` 完整输出（无上限落盘，界面只取最后 16 KB），宿主自己从不清理。实测一台装了二十来个插件的机器：141 份日志共 792.6 KB，而同一份 profile 的配置本身只有 46.4 KB —— 备份被日志撑大 19 倍，887 KB 距 Gist 单文件 1 MB 上限只剩 137 KB。默认排除后备份回到 46.4 KB。
- 开关语义是**只管收集、不管恢复**：恢复按备份里实际有什么写（备份可能来自另一台机器，那边的开关与这边无关），所以带日志的备份照常恢复。`run.json` 例外 —— 永不收集、永不写回，它记的是写备份那台机器的 pnpm 进程号，写回来会让本机下次装插件报「process N is still running」；跳过项会在恢复结果里列出。
- `PROFILE_SKIP` **没有**加入 `.plugin-manager`：它同时决定恢复端拒收什么，而 dshmarket 的备份里带着这些日志，加进去就会拒收本来能正常恢复的备份。

### 修复

- **超限报错说不出原因**：备份超过 1 MB 时只报「超过 GitHub Gist 1 MB 限制」。现在会点名最大贡献者（打开日志开关时直接说「其中 X KB 是安装日志，关掉就能去掉」），并解释为什么必须拦住 —— GitHub 读取时会截断超过 1 MB 的文件，恢复端只能拿到半份 JSON。
- **被截断的备份报成「JSON 无效」**：`readGistBackupContent` 现在检查 GitHub 的 `truncated` 标记；超 1 MB 的文件只返回前一部分，那种情况直接报「备份过大」，而不是让人以为备份坏了。

### 新增

- `scripts/itest-plugin-logs.mjs`（18 项）：默认不收 `logs/`、打开后收日志但不收 `run.json`、`pluginLogBytes` 计量、严格校验放行带日志的备份（dshmarket 会写这种）、恢复按备份内容写回并跳过 `run.json`、无日志的备份不创建 `.plugin-manager`。

### 界面

- 「备份变量设置」改名为「备份设置」，正文说明压到一行；新增「备份里附带插件安装日志」开关（默认关），灰字按开关当前状态给一句标价。
- 新增「查看备份内容」按钮与预览弹窗：按 **主要**（`package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml` —— 决定装哪些插件、怎么加载）与 **次要**（其余配置，写回不改变行为）分组，逐个列出文件体积，底部显示合计 / 1 MB 上限 / 余量，日志条目带「日志」标签。走的是与真正备份同一条收集路径（`previewProfileBackup`），所以显示的就是上传时的体积。
- 删掉独立的「保存 Token」按钮：Token、Gist ID、备份内容、定时设置统一由底部一个「保存设置」保存。因为 `saveConfig` 是部分合并，这个请求现在把需要落盘的字段一次带全（Token、Gist ID、设备名、定时、日志开关）。
- 「测试连接」和「查看备份内容」都按**界面上当前的值**工作，而不是上次保存的值：刚粘贴的 Token 不必先保存就能测；刚打开日志开关、还没保存时预览也能看到日志。

## [0.1.11] - 2026-10-19

### 变更

- **适配 DSH 0.2.1-rc.2**：三个宿主包的 peerDependencies 各追加 `^0.2.1-rc.1`（`0.2.0-rc` 线保留），开发依赖升到 `@deepseek-ai/cordis` ^4.0.5、`@deepseek-ai/dsh-host-webserver` / `dsh-settings` / `dsh-storage-domain` ^0.2.1-rc.2、`@deepseek-ai/schemastery` ^3.18.5、`zod` ^4.6.7、`@types/node` ^26.6.5。注意 `^0.2.0-rc.1` 匹配不到 `0.2.1-rc.2` —— semver 要求预发布段的 `major.minor.patch` 与比较器完全一致，所以这一条必须单独写出来。
- **本地类型声明保留，理由已更新**：`dsh-storage-domain` 0.2.1-rc.2 确实发布了 `lib/types/`，但直接用它的 `domainTable<ZodType<V>>` 签名会让 zod schema 触发 `TS2589`（类型实例化过深），因此仍用 `src/types/` 里的结构式重声明，运行时用真包。注释从「该包不发布 .d.ts」更正为这个实际原因。

### 新增

- **`scripts/itest-host-compat.mjs`（真宿主联调）**：真 `cordis` Context + 真 `dsh-host-webserver`（0.2.1-rc.2，`port: 0` 由系统分配端口），把插件按 DSH 的方式 `ctx.plugin()` 挂上去，再用真实 HTTP 打自己的 RPC 路由：POST `getConfig` 应答 200、跨源 `Origin` 403、GET 405 且带 `allow: POST`、dispose 后端口释放。此前只有 `smoke-apply.mjs` 的 handler 级替身，宿主契约变动要等用户装上才发现。

### 说明

- 0.2.0-rc.2 → 0.2.1-rc.2 的契约比对：`dsh-storage-domain/lib/types/spec.d.ts` 与 `dsh-client-ui-settings` 的 `slots.d.ts` **逐字节相同**；`dsh-host-webserver` 的 d.ts 只有新增（`TlsConfig`、`getOrigin()`、`isWildcardHost` / `isLoopbackHost` / `normalizeBindAddress` / `bindUrlHost`，以及 `Config.host` 由字面量联合放宽为 `string`），`register` 与 `WebRoute` 未变。因此功能代码零改动 —— 这次只动依赖范围与验证手段。
- 全部 15 个测试脚本通过（含新增的 host-compat），`tsc --noEmit` 通过，产物重建。

## [0.1.10] - 2026-10-19

### 变更

- **排除清单与 dshmarket 对齐，不再备份 `pnpm-lock.yaml`**：`PROFILE_SKIP` 加入 `pnpm-lock.yaml`，与上游 `SKIP_NAMES` 逐项一致。此前 `includeLock: true` 产出的备份含该文件，上游 `validatedBackup` 会判为 `excluded backup path` 直接拒收 —— 那份备份能从这里上传，却无法在插件市场恢复。lockfile 钉死的是某一台机器解析出的依赖树，恢复时 `pnpm install` 会按 `package.json` 重新生成，搬过去只会和安装过程打架。
- **移除 `includeLock` 开关**：`GistBackupConfig` 删掉该字段，`collectProfileBackup()` 不再收参数，host 端 `saveConfig` 不再归一化它；旧 `config.json` 里的残留字段在读取时丢弃，不会随每次保存继续流传。
- **旧备份的报错改成可操作**：恢复一份带 `pnpm-lock.yaml` 的历史备份时，校验失败信息从「含被排除的路径」改为说明哪些名字不参与备份、并要求用新版重新备份 —— 否则用户只会看到一个莫名的路径名。

### 修复

- **校验放过了「不是本插件的备份」**：`validateBackupStrict` 此前只要求 `format` 是非空字符串，任何格式名都能通过，既不比对 `version`、也不要求含 `package.json`、也不限总大小。现在与 dshmarket 的 `validatedBackup` 逐条对齐：`format` 必须是 `dsh-profile-backup`、`version` 必须是 `0.2`、必须有一份 `package.json`（只有它用 `json`，其余文件必须给 `lines`）、总大小上限 2 MB。其中影响最大的是「没有 package.json 也能恢复」—— 恢复要靠它决定装哪些插件，缺这一项会变成「恢复成功，但插件一个都没回来」，而用户看不出哪里不对。
- **恢复会穿过符号链接写到 profile 之外**（严重）：此前建父目录用 `mkdirSync(dirname, { recursive: true })`，路径上的中间层一概不检查。备份里一条 `dsh/plugins/x.json`，只要 `dsh` 是指向 profile 外部的链接，文件就落到外部去了。现在按 dshmarket 的 `ensureSafeParent` 方式逐段建目录，每段都必须是真实目录；另外补了一条 `realpathSync.native` 的真实路径比对 —— Windows 目录联接（junction）的 `lstat` 会报「普通目录、非符号链接」，只照抄上游那套 `lstat` 检查在本机实测仍被穿过（文件确实写到了 profile 外），只有解析真实路径才拦得住。
- **新增 `scripts/itest-restore-safety.mjs`**：覆盖链接父目录被拒、`..` 逃逸被拒、目录挡在文件位被拒、正常嵌套路径仍能建目录写入。`itest-strict-validation.mjs` 同步扩到 19 个用例（格式名、版本、缺 package.json、2 MB 上限等），其旧用例的 `format: 'x'` 夹具在新契约下会先被格式门槛拦下，已改为合法信封再逐条断言各条规则。
- **下载断流要等 30 秒才报错**：`gistHttp` 的响应只挂了 `end`，响应中途断流（连接重置、body 传一半、或我们自己 `destroy`）根本不会发 `end`，Promise 只能干等那个 30 秒硬顶 —— 明明早就失败了，用户还在看转圈。现在补 `res.once('error')`（与 dshmarket 的 `gistRequest` 一致），当场以 `netError` 结算。
- **超限响应报的是一句英文**：顺着上一条把 `destroy` 的原因从 `GitHub response is too large` 改成「GitHub 返回的内容超过备份大小上限，已中止读取」—— 这句话会原样显示在界面上。
- **不再按 `dsh-config-backup.json` 这个文件名猜**：`readGistBackupContent` 曾为这个上游从来不写的名字留一档兜底。认一个我们从不产出的名字，只会多一条读到错文件的路径。现在只认自己的文件名，或内容自称是 dsh 备份的那个文件 —— 手工建的 gist 照样能读（互通本来就靠内容识别覆盖），`cross-verify.cjs` 场景 4 改为断言「名字不被认、内容才被认」。

### 界面

- 「备份变量设置」里的「同时备份 pnpm-lock.yaml（约 115KB）」开关移除，改为一行灰字列出备份内容与完整的排除清单。开关没了，用户仍能一眼看到备份里有什么、为什么不含 lockfile。

## [0.1.9] - 2026-10-05

### 变更

- **兼容 DSH 0.2.0-rc.2**：三个宿主包的 peerDependencies 各追加 `^0.2.0-rc.1`（dsh-host-webserver / dsh-settings / dsh-storage-domain，沿用 dshmarket 的 range 写法），保持向后兼容旧版本（0.1.5-rc.1+）。功能代码零改动——已对 0.2.0-rc.2 逐一核实插件用到的全部宿主契约：`webServer.register({kind:'exact'})` 路由注册、`storageDomain` 服务（`defineDomain` / `domainTable` / `invalidRecords: 'backup-and-skip'` / `table.put/delete/keys()/entries()` 迭代器 / `domain.close()`）、客户端 `window.__ModuleLoader__` 加载格式、`schemastery` 3.18.4、`zod` 4.4.3、`cordis` 4.0.4，全部保持不变。
- devDependencies 对齐：`dsh-storage-domain` 升到 `^0.2.0-rc.1`，类型检查对着新版 API 跑。

## [0.1.8] - 2026-09-28

### 修复

- **定时备份失败静默丢失**（严重）：定时备份失败此前只 `console.error`，UI 上看起来一切正常，「上次备份」时间悄悄停在几周前——备份链早断了用户却毫无察觉。现在失败也写一条 `status: 'failed'` 的上传记录进 storage domain（含错误原因），UI 上以红色「失败」徽章展示，鼠标悬停显示错误详情；「上次备份」只统计成功记录，全部失败时显示「上次成功备份：无」。
- **config.json 非原子写 → token/gistId 静默丢失**：`writeBackupConfig` 此前用裸 `writeFileSync`，崩溃中途截断会让 `readBackupConfig` 静默回默认值，token 和 gistId 全丢。改为调用同文件已有的 `writeFileAtomic`（临时文件 + rename），崩溃不会截断。
- **存储层一条脏记录 = 全表丢失**（严重）：`uploadDomainSpec` 未声明 `invalidRecords: 'backup-and-skip'`，一条不合规记录（未来 schema 演进、手编辑、写损坏）会让 `open()` 抛错 → 静默降级 config.json → 迁移已清空 → UI 历史归零。现在脏记录会被 `backupRecord` 移走并记日志，其余记录照常加载。
- **同毫秒两次备份静默覆盖**：storage domain 的 key 此前用纯 `uploadedAt`（ISO 毫秒），定时器重叠或手动+定时并发时同毫秒写入会让第二条覆盖第一条。key 改为 `uploadedAt + "-" + randomBytes(4)`，ISO 前缀保证排序仍按时间。

### 变更

- **备份加互斥锁**：复用 restore 的并发保护模式，新增 `backupInFlight` 标志。定时 tick 撞上正在跑的备份时跳过本次（不记失败、不污染历史）；手动备份撞上时返回 `backup_in_progress` 让 UI toast 提示。消除并发空 gistId 场景下建双 gist + 孤儿 + config 竞态覆盖的路径。
- **UI 新增定时备份警告**：开启定时备份后，执行区域出现黄色警告条「⚠ 定时备份仅在 DSH 运行期间执行。DSH 关闭、退出或电脑休眠时不会备份，也不会补跑错过的周期。」——明确「进程内 setInterval」的语义边界，避免用户误以为这是系统级 cron。
- **上传记录失败行渲染**：表格支持 `failed` 状态行——红色徽章「失败」、大小列显示「-」、悬停 tooltip 显示错误原因。

## [0.1.6] - 2026-09-27

### 修复

- **兼容 schemastery 3.18.4 的声明生成**（构建修复）：3.18.4 把 `Schema` 从 2 个泛型参数改为 3 个（新增 `SchemaMode`），且 `Schema` 类型别名不再从模块导出（改为默认导出的同名合并），导致 `tsc --emitDeclarationOnly` 报 TS2883（推断类型不可移植）。`Config` 改为显式注解 `z<{ gistApiHost: string }>`（与官方 dsh 包 `schema: z<T>` 写法一致），声明文件不再引用不可移植类型。

### 变更

- **兼容 DSH 0.1.7-rc.2**：peerDependencies 追加 0.1.7-rc.2（dsh-host-webserver / dsh-settings / dsh-storage-domain），保持向后兼容旧版本（0.1.5-rc.1+）。
- devDependencies 对齐：dsh-storage-domain 0.1.7-rc.2、schemastery ^3.18.4。

## [0.1.5] - 2026-09-25

### 变更

- **兼容 DSH 0.1.7-rc.1**：peerDependencies 追加 0.1.7-rc.1（dsh-host-webserver / dsh-settings / dsh-storage-domain），保持向后兼容旧版本（0.1.5-rc.1+）。经源码核对 storageDomain / webServer API 在 0.1.7-rc.1 未变。

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

[0.1.12]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.8...v0.1.9
[0.1.3]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/jacket-sikaha/dsh-market-gist-autosync/releases/tag/v0.1.0
