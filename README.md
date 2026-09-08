# command-market（Bench 命令市场）

> Bench 命令中心的**命令发布仓库**：命令脚本与 Bench 应用解耦发布——发布/更新命令不需要重新发布 Bench 客户端。
> 宿主能力：命令中心「命令市场」标签（浏览 → 一键安装到本地命令卡片库）。
> 消费契约见 Bench 仓库 `docs/extension-workflow.md` §12 与 `src-tauri/src/command_center/market.rs`。

## 目录结构

```
command-market/
├── registry.json          # 市场索引（schemaVersion / updatedAt / commands[]）
└── commands/
    └── <command-id>.json  # 单命令文件（schemaVersion/id/version/title/description/kind/command/icon）
```

## 命令文件格式（schema v1）

```jsonc
{
  "schemaVersion": 1,
  "id": "clear-browser-history",     // ^[a-z][a-z0-9-]*$，发布后不可改
  "version": "1.0.0",                // 三段语义化版本，更新时递增
  "title": "清除浏览记录",
  "description": "关闭 QuickTime 并清理…",
  "kind": "shell",                   // shell | shellAdmin | copy | open
  "command": "osascript -e '…'",     // 脚本正文（shell/shellAdmin 为 shell 脚本，copy 为文本，open 为路径/URL）
  "icon": "Trash2"                   // 可选，lucide 图标名
}
```

## 发布流程（改完命令后）

```bash
node scripts/build-registry.mjs   # 重算 sha256/size 并重写 registry.json
git add -A && git commit -m "feat(command): <说明>" && git push
```

推送后，在 Bench 侧配置市场源环境变量即可拉取：

- `BENCH_COMMAND_MARKET_URL`：远程索引 URL（如 GitHub Raw / jsDelivr 指向 `registry.json`，https）；
- `BENCH_COMMAND_MARKET_DIR`：本地目录（开发调试用，指向本文件夹）。

两者都未配置时，Bench 命令中心的「命令市场」显示为空（能力保留，不影响本地命令）。

## 安全语义（与 Bench 宿主实现一致，fail-closed）

- registry `schemaVersion` 必须与宿主支持版本一致；
- 每个命令文件按 registry 登记的 `sha256` + `size` 校验，不符即拒绝安装；
- 安装走版本单调检查：同 id 已装版本 ≥ 新版本时拒绝降级；
- `kind` 与 `command` 非法即拒绝；安装记录来源与版本（可升级、可追溯）。
