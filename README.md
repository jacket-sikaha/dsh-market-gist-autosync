# dsh-market-gist-autosync

把 DSH 配置定时备份到 GitHub Gist 的插件。

## 功能

- 配置 GitHub Gist token 与 gist id（或 URL）
- 把 `$DSH_HOME` 下的配置（settings.yaml、*.json、profiles/、skills/ 等）打包上传为私有 Gist
- 未配置 token / token 无效 / gist id 无效时返回明确的中文失败原因
- 自持定时备份（`scheduleEnabled` + `scheduleIntervalHours`）

## 安装

```bash
dsh plugin --profile desktop add dsh-market-gist-autosync
```

## 配置

配置持久化在 `$DSH_HOME/gist-autosync/config.json`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `gistToken` | `""` | GitHub token（明文存本地文件） |
| `gistId` | `""` | 已有 Gist id 或 URL；空 = 每次新建 |
| `fileNamePrefix` | `config` | 自动命名前缀 |
| `fileName` | `""` | 完全自定义文件名（置空用自动命名 `config-<时间戳>-<设备名>.json`） |
| `deviceName` | `""` | 设备名（空则自动探测） |
| `scheduleEnabled` | `false` | 是否定时备份 |
| `scheduleIntervalHours` | `24` | 周期间隔（小时） |
