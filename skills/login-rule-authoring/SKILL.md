---
name: login-rule-authoring
description: >
  为 Bench 账号管理编写与更新「站点登录判定规则」（command-market 仓库 rules/ 板块）。
  当用户要求：新增某站点登录规则、更新站点登录逻辑、排查登录误判、站点改版后规则失效时使用。
  方法论沉淀自 2026-09-10 trae.cn CheckLogin 误判案例的完整闭环（快照差异分析 → 前端逆向 →
  探针实测矩阵 → 捕获链路核验 → 规则发布 → 技术家族归类）。
---

# login-rule-authoring — 站点登录判定规则研发方法论

> **定位**：本 skill 是 command-market `rules/` 板块的**规则作者手册**。规则是纯声明式
> JSON（schema v1），由 Bench 宿主（Rust）解释执行，本 skill 只产出「站点先验配置」。
> 调研中发现**宿主侧缺陷**（捕获/探针引擎问题）时不改宿主代码：单独提报宿主仓库
>（tauri-app `account_manager`），并在规则 description 中标注前置条件。
> 规格真相源：tauri-app `docs/reference/login-rulepack-spec.md`。

## 0. 判定原理（证据分层）

| 层 | 证据 | 方向 | 说明 |
| --- | --- | --- | --- |
| S1 | 站点自己的鉴权接口探针（`loginCheck`） | 肯定 + 否定 | **唯一**同时具备两个确定方向的方案，规则包首选 |
| S2 | HTTP 401/403 | 仅否定（强） | 传统服务端渲染站点有效；SPA 常无效（首页恒 200） |
| S4 | 指纹全缺失 → 否定短路 | 仅否定 | 「特征存在」绝不直接判登录（弱肯定不定论） |
| S5/S6 | cookie/storage 存在性、页面文本/selector | 弱 | 已实测证伪或 SPA 同构无区分度，禁止单独定论 |

**核心判断**：任何客户端残留（cookie/storage/指纹）只能提供「否定」方向的确定性；
「肯定」必须由服务端裁决。规则的目标就是把「该站点用哪个端点、哪种判定形态、
什么凭证形态」这一先验写准。

## 1. 调研 SOP（六步，按序执行，缺一步都可能重蹈 trae.cn 覆辙）

### Step 1 — 快照差异分析（判定信号在哪）

1. 取同一站点**已登录 vs 未登录**的 `bench-account-snapshot` 导出，逐层对比：
   `session` 是否为 null → `origins[].localStorage` 关键 key → `cookies` 逐个定性。
2. **cookie 逐个定性是必做项**：字节系 analytics（`__tea_cache_tokens_*`、`gfkadpd`、
   `s_v_web_id`、`ttwid`）匿名访问即存在，与登录态无关——「存在且长度一致」= 无判别力。
3. localStorage 里的 JWT 一律解码验真（header/payload/exp/iat）：
   ```bash
   node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64").toString()))' <jwt>
   ```
   记录 TTL（exp−iat）与 user id 字段路径。trae.cn 案例：`Cloud-IDE-Token` 为 8h TTL JWT。
4. **不要从 `account.status` 下结论**——它可能是宿主误判的结果（三个账号同显
   loginRequired 的案例），快照里的原始 session 明文才是 ground truth。

### Step 2 — 前端逆向定位鉴权方式

1. `curl` 站点首页 HTML → 提取全部 `<script src>` → 批量下载 → grep 关键字：
   `CheckLogin|Authorization|token|login|passport|api\.<域>`。
2. 找到候选端点后**还原完整调用形态**：method、headers 构造（scheme 前缀！）、body、
   以及该端点在站点里的真实用途。
3. **教训（trae.cn）**：bundle 里 `Authorization:"Cloud-IDE-JWT ".concat(token)` 是
   IDE 类接口的 scheme；CheckLogin 本身是**纯 cookie 鉴权**（`GetUserToken` 调用不带
   任何 header，靠 passport cookie 换 token）。**单一代码片段不能下结论**，必须与
   Step 3 的实测矩阵互相印证。

### Step 3 — 探针实测矩阵（写规则前必须全过）

对候选端点用**真实快照凭证**实测，负样本（无效/过期 token）必须包含：

| # | 形态 | 预期结论 |
| --- | --- | --- |
| A | 无凭证（模拟未登录） | 记录匿名基线响应 |
| B | 仅快照捕获到的 cookie | 验证「探针只能用捕获层凭证」的现实约束 |
| C+ | 各候选 header 形态 × 有效 token（Bearer / 站点私有 scheme / 自定义头） | 记录是否被接受 |
| I | 候选形态 × **无效 token**（负样本） | 确认能区分「无效凭证」与「无凭证」 |
| J | 有效形态 × 空 body / 官方 body | 确认 body 是否影响判定 |

用 node `fetch` 跑（undici 允许自定义 Cookie 头）。结论写入规则 description（带日期）。
trae.cn 案例：6 形态全 `IsLogin:false` → 纯 cookie 型成立，token 头方案全部否决。

### Step 4 — 捕获链路核验（★★★★★ 本案例最大教训）

**探针能用的凭证 = 宿主捕获层给进 canonical session 的凭证。** 规则写得再准，
捕获层丢了凭证，探针就退化成匿名请求 → 恒判未登录，且失效方向与「站点改版」难以区分。

1. 对照快照 cookies 列表与磁盘 WebView cookie store：
   ```bash
   strings ~/Library/WebKit/<bundle>/WebsiteDataStore/<store>/Cookies/Cookies.binarycookies \
     | grep -oE "sessionid|sid_guard|ttwid|<候选凭证名>" | sort -u
   ```
   磁盘有、快照没有 → 捕获层缺陷。
2. trae.cn 实锤案例：wry ≤0.55 `cookies_for_url` 是 `cookie.domain() == url.domain()`
   **精确字符串匹配**，`.trae.cn` 域级 cookie（sessionid/sid_guard/ttwid/passport_csrf_token）
   全部被过滤。修复：宿主全量 `cookies()` + RFC 6265 domain-match 自行过滤
   （`session.rs cookies_for_target`）。
3. 发现捕获/引擎缺陷 → **提报宿主仓库**，规则侧在 description 标注前置条件；
   规则探针形态优先选择「宿主现有能力 + 已捕获凭证」可行的组合。

### Step 5 — 写规则并校验

1. 文件名 = 规则 id = 可注册域（`rules/<id>.json`）；`schemaVersion: 1`；version 递增。
2. `loginCheck`：url 必须 https 且同可注册域（同域铁律，防投毒外泄 session）；
   method 白名单 GET/POST（POST 空 body 为默认语义，站点要 body 时实测后在
   description 标注，当前 schema 无 body 字段则该形态不可用）；`expect.kind` 选
   `status | jsonBool | bodyContains` 之一，jsonBool path 仅 `[A-Za-z0-9_.]`。
3. `fallback`：仅 text/selector 弱证据；SPA 同构 shell 站点（如 trae.cn）不提供。
4. description 必须沉淀：鉴权形态、实测日期与矩阵结论、前置条件、已知陷阱。
   这条 description 就是「随站点更新而更新」的知识载体。
5. `node scripts/build-rules.mjs` 校验 + 重算索引（CI 兜底）。

### Step 6 — 三口径验证 + 发布

- 验证口径固定为三分类：**登出账号 / 登录账号 / 残留会话账号**，规则更新后全对才算数。
- 发布：commit（`feat(rule): ...`）+ push main；CI 重算索引兜底；宿主 24h TTL 拉取
  或重启应用生效；远程规则版本 > bundled 即覆盖（同版本取 remote）。
- 发布后如误判仍在 → 回 Step 4（八成是捕获层/宿主链路，不是规则）。

## 2. 技术家族分类（taxonomy v0，随规则数增长演进）

新站点先归类 → 继承家族的陷阱清单与探针形态模板 → **仍须完成全矩阵实测**，
分类只减少试错，不替代验证。

| 家族 | 已知成员 | 鉴权载体 | 探针形态 | 陷阱 |
| --- | --- | --- | --- | --- |
| **bytepassport**（字节系 passport） | trae.cn | 域级 cookie（sessionid/sid_guard/sid_tt/ttwid/passport_csrf_token），storage 侧 JWT 仅用于 IDE 类接口 | `CheckLogin` 式 POST + JSON 布尔 | ① token 头全部无效；② 域级 cookie 依赖宿主捕获完整性；③ 风控敏感，探针严禁高频 |
| **github** | github.com | cookie（host 域） | `api.github.com/user` 401/200（status kind） | API 与网页会话可能不同源，需分别验证 |
| **oidc/saas**（预留） | — | id_token / silent auth | `prompt=none` 或 check_session iframe | iframe 域与凭据跨域限制 |

后续家族按「鉴权载体 × 探针形态 × 已知陷阱」三要素扩充本表。

## 3. 铁律与陷阱清单（fail-closed）

1. **同域铁律**：loginCheck.url 必须 https 且与 match.registrableDomain 同域，
   method ∈ {GET, POST}，不跟随重定向——loginCheck 携带账号凭证，同域约束下
   规则投毒无法外泄 session。
2. **禁止 cookie/storage 存在性启发**：匿名访问即存在的特征（字节 analytics 族）
   已实测证伪，不得作为判据。
3. **token 头注入默认不做**：须宿主 schema 支持 + 实测被端点接受（trae.cn 已实测
   否决 Bearer / Cloud-IDE-JWT / X-Cloudide-Token 三种）。看到前端带 header 不代表
   目标端点认它。
4. **弱肯定不定论**：指纹/特征「存在」永远不直接判 Ready；否定短路只在「全缺失」时成立。
5. **捕获层前提**：规则依赖的凭证必须能进宿主 canonical session；写规则前过 Step 4。
6. **description = 知识载体**：每条规则必须写明鉴权形态、实测日期、矩阵结论、
   前置条件；version 严格递增（版本单调守卫会拒绝降级）。
7. **频率自律**：判定探针是站点 API 的真实请求；规则 description 中标注
   「风控敏感度」，风控敏感家族（bytepassport）禁止任何高频轮询式用法。

## 4. 工具命令速查

```bash
# JWT payload 解码（exp/iat/TTL）
node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64").toString()))' <jwt>

# 站点首页 JS bundle 批量抓取与关键字检索
curl -s -A "<UA>" https://<站>/ -o home.html
grep -o 'src="https://cdn[^"]*\.js"' home.html | sed 's/src="//;s/"$//' | sort -u > urls.txt
while read -r u; do curl -s -o "js/$(basename "$u")" "$u"; done < urls.txt
grep -l "CheckLogin\|Authorization\|passport" js/*.js

# WKWebView cookie store 凭证名扫描（只看名字与域，不看值）
strings ~/Library/WebKit/<bundle>/WebsiteDataStore/<store>/Cookies/Cookies.binarycookies \
  | grep -oE "sessionid|sid_guard|ttwid|<凭证名>" | sort -u

# 探针矩阵脚本骨架（node fetch；undici 允许自定义 Cookie 头）
# 见 /tmp/trae-probe-test*.mjs 模式：逐形态 fetch → 解析 Result.IsLogin / 状态码 → 表格输出
```

## 5. 保活（keepAlive）前瞻 —— schema v2 候选，宿主支持前不入 rules

保活与判定是**两类操作**：判定是只读查询，保活可能触发风控/写操作/会话刷新。
设计原则：规则显式声明、宿主解释执行、默认关闭、独立审计。

```jsonc
"detection": {
  "loginCheck": { /* v1 现有 */ },
  "tokenHints": {                    // v2 候选：给保活调度用的会话元数据
    "storageKey": "Cloud-IDE-Token", // 凭证位置
    "jwtExpPath": "exp",             // 过期时间解析路径（相对秒）
    "refreshEndpoint": "/cloudide/api/v3/common/GetUserToken"  // 刷新端点（可选）
  },
  "keepAlive": {                     // v2 候选：保活策略
    "endpoint": "...",               // 保活打点（同域铁律同样适用）
    "minIntervalSec": 21600,         // 频率下限（宿主全局预算再收敛）
    "jitterSec": 600,                // 抖动，避免集群节奏
    "riskLevel": "high"             // 风控敏感度：low | medium | high
  }
}
```

- 宿主按 `jwtExpPath` 在「过期前留余量」时调度保活，而非固定周期轮询；
- `riskLevel: high` 的家族（bytepassport）保活默认关闭，仅判定；
- 全局频率预算归宿主统一管理（站点数量 × 各站下限），规则只给下限与风险标注。
