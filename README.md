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
# CI 自动重算 registry.json（无需手动跑 build-registry；本地想预览再跑一遍也无妨）
```

本仓库属 GitHub 组织 [`kindred-plugin-market`](https://github.com/kindred-plugin-market)（与
[plugin-market](https://github.com/kindred-plugin-market/plugin-market) 插件市场并列）。推送 main 后
CI 自动重算 `registry.json`，Bench 侧配置市场源即可拉取：

- `BENCH_COMMAND_MARKET_URL=https://raw.githubusercontent.com/kindred-plugin-market/command-market/main/registry.json`
- `BENCH_COMMAND_MARKET_DIR`：本地目录（开发调试用，指向本文件夹）。

两者都未配置时，Bench 命令中心的「命令市场」显示为空（能力保留，不影响本地命令）。

## 安全语义（与 Bench 宿主实现一致，fail-closed）

- registry `schemaVersion` 必须与宿主支持版本一致；
- 每个命令文件按 registry 登记的 `sha256` + `size` 校验，不符即拒绝安装；
- 安装走版本单调检查：同 id 已装版本 ≥ 新版本时拒绝降级；
- `kind` 与 `command` 非法即拒绝；安装记录来源与版本（可升级、可追溯）。

---

# 登录规则板块（login rules）

> 本仓库同时承载 Bench 账号管理的**登录判定规则包**：站点登录态检测规则与 Bench 应用解耦发布——修正/新增站点规则不需要重新发布 Bench 客户端。
> 规则是**纯声明式 JSON**（不含可执行内容），由 Bench 宿主（Rust）解释执行；判定引擎随 Bench 版本发布，本板块只发「站点先验配置」。
> 契约规格见 Bench 仓库 `docs/reference/login-rulepack-spec.md`（规格真相源）。与命令市场体系相互独立：`registry.json`（命令）/ `rules.json`（登录规则）各自独立演进 `schemaVersion`，老客户端不受本板块影响。

## 目录结构

```
command-market/
├── registry.json          # 命令市场索引（不变）
├── commands/              # 命令文件（不变）
├── rules.json             # 登录规则索引（schemaVersion 1）
├── rules/
│   ├── <id>.json          # 单站点规则，文件名 = 规则 id = 可注册域（如 trae.cn.json）
│   └── generic.json       # 通用兜底规则（id 固定 "generic"，match 省略 = 全局生效）
└── skills/
    └── login-rule-authoring/SKILL.md
                            # 规则作者方法论（AI 用：站点登录规则的调研/实测/发布 SOP
                            # 与技术家族分类；不进索引，宿主不消费，CI 不校验）
```

## 规则文件格式（schema v1）

```jsonc
{
  "schemaVersion": 1,
  "id": "trae.cn",                    // 可注册域，= 文件名，发布后不可改
  "version": "1.0.0",                 // 三段语义化版本，更新时递增
  "title": "Trae 云端 IDE",
  "description": "…",
  "match": {
    "registrableDomain": "trae.cn",   // 必填，= id
    "hosts": ["www.trae.cn", "api.trae.cn"] // 可选，精确 host 匹配（specificity 更高）
  },
  "detection": {
    "loginCheck": {                   // 可选；S1 服务端权威探针（强判据）
      "url": "https://api.trae.cn/cloudide/api/v3/trae/CheckLogin",
      "method": "POST",               // 白名单 GET | POST（POST 空请求体）
      "expect": {
        "kind": "jsonBool",           // status | jsonBool | bodyContains
        "path": "Result.IsLogin"
      }
    },
    "fallback": {                     // 可选；弱证据（loginCheck 缺失/不可用时）
      "loggedIn":  [{ "kind": "text", "value": "退出登录" }],
      "loggedOut": [{ "kind": "selector", "value": "a[href^='/login']" }]
    }
  }
}
```

### 通用规则（generic，全局兜底）

站点规则按可注册域匹配，**未命中任何站点规则的站点**回落到 `generic` 通用规则：

- `id` 固定为 `"generic"`（非域名特例，构建脚本与宿主双侧放行）；`match` 必须省略（全局生效）；
- **禁止定义 `loginCheck`**——通用规则无法预知各站点的同域鉴权接口，强行下发会破坏同域铁律；必须提供 `fallback` 文本弱证据；
- 匹配优先级：站点特殊规则（精确 host > 可注册域）> generic 兜底；generic 恒为弱证据，不影响证据分层。

### 安全铁律（构建脚本与宿主双重校验，fail-closed）

- `loginCheck.url` 必须 **https** 且与 `match.registrableDomain` **同一可注册域**——loginCheck 携带账号 cookie 发请求，同域约束保证规则投毒无法把 session 发往第三方；
- `loginCheck.method` 白名单 `GET | POST`（POST 空请求体，查询型鉴权接口语义）；不跟随重定向；
- `fallback` 仅允许 `text` / `selector` 两类弱证据（cookie/storage 存在性启发已被实测证伪，不收录）；
- 未知字段、非法 kind、路径穿越一律拒绝。

## 发布流程（新增/修改规则后）

```bash
node scripts/build-rules.mjs      # 校验 + 重算 sha256/size 并重写 rules.json
git add -A && git commit -m "feat(rule): <说明>" && git push
# CI 自动重算 rules.json 兜底；Bench 端 24h TTL 拉取生效（或重启应用）
```

## Bench 宿主消费方式

- 默认源（零配置）：`https://raw.githubusercontent.com/kindred-plugin-market/command-market/main/rules.json`
- env 覆盖：`BENCH_LOGIN_RULES_URL`（https 规则索引 URL）或 `BENCH_LOGIN_RULES_DIR`（本地目录，开发调试直接读盘）
- 缓存：`$APPDATA/login-rules/`；拉取失败静默沿用旧缓存或内置规则，不阻塞探测
- 优先级：用户手配规则 > 本仓库远程规则 > Bench bundled 内置规则 > 预设文本
