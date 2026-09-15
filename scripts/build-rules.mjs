#!/usr/bin/env node
/**
 * login-rule 索引（D03）：扫描 rules/*.json（站点登录判定规则包），按 spec
 * fail-closed 校验后纯计算索引，`--check` 只读比对，显式写入用原子替换。
 *
 * 三阶段分离（03 §3 D03，与 build-registry.mjs 同模式）：
 *   纯计算  buildRulesIndex({ entries })  — 校验 + 计算，无 IO 副作用
 *   只读    --check                        — 比对 schema/集合/id/hash/size，绝不写
 *   显式写  （默认）                        — payload 未变时保留 updatedAt
 *
 * 两索引一致性：`check:indexes` 同时校验 registry.json 与 rules.json 与各自源文件
 * 的一致性（D02 + 本脚本），写回职责仍归业务流程（CI 不写）。
 *
 * 校验规则与 Bench 宿主（src-tauri/src/account_manager/login_rules.rs）一致，
 * 规格见 Bench 仓库 docs/reference/login-rulepack-spec.md。
 * **绝不执行规则中的任何系统命令。**
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// 测试/工具可通过 BENCH_RULES_MARKET_DIR 覆盖仓库根（默认：脚本所在仓库）。
const MARKET = process.env.BENCH_RULES_MARKET_DIR
  ? resolve(process.env.BENCH_RULES_MARKET_DIR)
  : join(dirname(fileURLToPath(import.meta.url)), "..")
const RULES_DIR = join(MARKET, "rules")
const RULES_INDEX_PATH = join(MARKET, "rules.json")
const SCHEMA_VERSION = 1

export class RuleError extends Error {
  constructor(message) {
    super(message)
    this.name = "RuleError"
  }
}

// 通用兜底规则 id（非域名）：match 必须省略（全局生效）、禁止 loginCheck
//（通用规则无法预知各站点同域鉴权接口）、必须提供 fallback。站点特殊规则优先于它。
export const GENERIC_ID = "generic"

// 与宿主 serde deny_unknown_fields 对齐的已知字段白名单。
export const KNOWN = {
  rule: ["schemaVersion", "id", "version", "title", "description", "match", "detection"],
  match: ["registrableDomain", "hosts"],
  detection: ["loginCheck", "fallback"],
  loginCheck: ["url", "method", "expect", "prerequisiteCookies"],
  expect: ["kind", "path", "loggedIn", "loggedOut"],
  fallback: ["loggedIn", "loggedOut"],
  condition: ["kind", "value", "presence"],
}

const unknownFields = (obj, allowed) => Object.keys(obj).filter((k) => !allowed.includes(k))

const isRegistrableDomain = (v) =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)

const isHost = (v) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)

const sameRegistrableDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`)

const isSemver = (v) => /^\d+\.\d+\.\d+$/.test(v)

function validateExpect(name, expect) {
  const extra = unknownFields(expect, KNOWN.expect)
  if (extra.length) throw new RuleError(`${name}: expect has unknown field(s): ${extra.join(", ")}`)
  if (!["status", "jsonBool", "bodyContains"].includes(expect.kind))
    throw new RuleError(`${name}: expect.kind \`${expect.kind}\` is invalid (status | jsonBool | bodyContains)`)
  if (expect.kind === "jsonBool") {
    if (!/^[A-Za-z0-9_.]+$/.test(expect.path ?? ""))
      throw new RuleError(`${name}: expect.path must match ^[A-Za-z0-9_.]+$`)
    return
  }
  for (const side of ["loggedIn", "loggedOut"]) {
    const list = expect[side]
    if (!Array.isArray(list) || list.length === 0)
      throw new RuleError(`${name}: expect.${side} must be a non-empty array for kind \`${expect.kind}\``)
    for (const item of list) {
      if (expect.kind === "status") {
        if (!Number.isInteger(item) || item < 100 || item > 599)
          throw new RuleError(`${name}: expect.${side} contains invalid HTTP status ${JSON.stringify(item)}`)
      } else if (typeof item !== "string" || item.length === 0) {
        throw new RuleError(`${name}: expect.${side} must contain non-empty strings`)
      }
    }
  }
}

function validateLoginCheck(name, domain, check) {
  const extra = unknownFields(check, KNOWN.loginCheck)
  if (extra.length) throw new RuleError(`${name}: loginCheck has unknown field(s): ${extra.join(", ")}`)
  if (!["GET", "POST"].includes(check.method))
    throw new RuleError(`${name}: loginCheck.method must be GET or POST`)
  let url
  try {
    url = new URL(check.url)
  } catch {
    throw new RuleError(`${name}: loginCheck.url is not a valid URL`)
  }
  if (url.protocol !== "https:") throw new RuleError(`${name}: loginCheck.url must be https`)
  if (!sameRegistrableDomain(url.hostname, domain))
    throw new RuleError(
      `${name}: loginCheck.url host \`${url.hostname}\` must share registrable domain \`${domain}\` (same-domain rule)`,
    )
  validateExpect(name, check.expect)
  if (check.prerequisiteCookies !== undefined) {
    if (!Array.isArray(check.prerequisiteCookies) || check.prerequisiteCookies.length === 0)
      throw new RuleError(`${name}: loginCheck.prerequisiteCookies must be a non-empty array`)
    for (const c of check.prerequisiteCookies) {
      if (typeof c !== "string" || c.length === 0)
        throw new RuleError(`${name}: loginCheck.prerequisiteCookies must contain non-empty strings`)
    }
  }
}

function validateCondition(name, side, cond) {
  const extra = unknownFields(cond, KNOWN.condition)
  if (extra.length)
    throw new RuleError(`${name}: fallback.${side} condition has unknown field(s): ${extra.join(", ")}`)
  if (!["text", "selector"].includes(cond.kind))
    throw new RuleError(`${name}: fallback.${side} condition kind \`${cond.kind}\` is invalid (text | selector)`)
  if (typeof cond.value !== "string" || cond.value.trim().length === 0)
    throw new RuleError(`${name}: fallback.${side} condition value must be a non-empty string`)
  if (cond.value.length > 200) throw new RuleError(`${name}: fallback.${side} condition value must be <= 200 chars`)
  if (cond.presence !== undefined && !["present", "absent"].includes(cond.presence))
    throw new RuleError(`${name}: fallback.${side} condition presence \`${cond.presence}\` is invalid`)
  if (cond.presence !== undefined && cond.presence !== "present" && cond.kind !== "text")
    throw new RuleError(`${name}: fallback.${side}: presence=absent is only valid for kind=text`)
}

function validateFallback(name, fallback) {
  const extra = unknownFields(fallback, KNOWN.fallback)
  if (extra.length) throw new RuleError(`${name}: fallback has unknown field(s): ${extra.join(", ")}`)
  for (const side of ["loggedIn", "loggedOut"]) {
    const list = fallback[side]
    if (list === undefined) continue
    if (!Array.isArray(list)) throw new RuleError(`${name}: fallback.${side} must be an array`)
    for (const cond of list) validateCondition(name, side, cond)
  }
}

export function validateRule(name, fileBase, body) {
  const extra = unknownFields(body, KNOWN.rule)
  if (extra.length) throw new RuleError(`${name}: unknown field(s): ${extra.join(", ")}`)
  if (body.schemaVersion !== SCHEMA_VERSION)
    throw new RuleError(`${name}: schemaVersion must be ${SCHEMA_VERSION}`)
  const isGeneric = body.id === GENERIC_ID
  if (!isGeneric && !isRegistrableDomain(body.id ?? ""))
    throw new RuleError(`${name}: id \`${body.id}\` is not a valid registrable domain`)
  if (body.id !== fileBase) throw new RuleError(`${name}: id \`${body.id}\` must equal file name (without .json)`)
  if (!isSemver(body.version ?? "")) throw new RuleError(`${name}: version \`${body.version}\` must be X.Y.Z`)
  if (typeof body.title !== "string" || body.title.trim().length === 0)
    throw new RuleError(`${name}: title must be a non-empty string`)

  const match = body.match
  if (isGeneric) {
    if (match !== undefined)
      throw new RuleError(`${name}: generic rule must not define match (applies globally)`)
  } else {
    if (!match || typeof match !== "object") throw new RuleError(`${name}: match is required`)
    const matchExtra = unknownFields(match, KNOWN.match)
    if (matchExtra.length)
      throw new RuleError(`${name}: match has unknown field(s): ${matchExtra.join(", ")}`)
    if (match.registrableDomain !== body.id)
      throw new RuleError(`${name}: match.registrableDomain must equal id \`${body.id}\``)
    if (match.hosts !== undefined) {
      if (!Array.isArray(match.hosts)) throw new RuleError(`${name}: match.hosts must be an array`)
      for (const host of match.hosts) {
        if (!isHost(host)) throw new RuleError(`${name}: match.hosts entry \`${host}\` is not a valid host`)
        if (!sameRegistrableDomain(host, body.id))
          throw new RuleError(
            `${name}: match.hosts entry \`${host}\` must share registrable domain \`${body.id}\``,
          )
      }
    }
  }

  const detection = body.detection
  if (!detection || typeof detection !== "object")
    throw new RuleError(`${name}: detection is required`)
  const detExtra = unknownFields(detection, KNOWN.detection)
  if (detExtra.length)
    throw new RuleError(`${name}: detection has unknown field(s): ${detExtra.join(", ")}`)
  if (detection.loginCheck === undefined && detection.fallback === undefined)
    throw new RuleError(`${name}: detection must define loginCheck and/or fallback`)
  if (isGeneric) {
    if (detection.loginCheck !== undefined)
      throw new RuleError(`${name}: generic rule must not define loginCheck (same-domain rule cannot apply globally)`)
    if (detection.fallback === undefined) throw new RuleError(`${name}: generic rule must define fallback`)
  }
  if (detection.loginCheck !== undefined) validateLoginCheck(name, body.id, detection.loginCheck)
  if (detection.fallback !== undefined) validateFallback(name, detection.fallback)
}

/** 纯计算：从规则源文件构建 rules 索引。fail-closed 校验，无 IO 副作用。 */
export function buildRulesIndex({ entries, now = defaultNow }) {
  const rules = []
  const seenIds = new Set()
  for (const { name, body: rawBody } of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const bodyBytes = Buffer.from(rawBody, "utf8")
    let doc
    try {
      doc = JSON.parse(rawBody)
    } catch (error) {
      throw new RuleError(`${name}: invalid JSON (${error.message})`)
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new RuleError(`${name}: must be a JSON object`)
    }
    const fileBase = name.replace(/\.json$/, "")
    validateRule(name, fileBase, doc)
    if (seenIds.has(doc.id)) throw new RuleError(`duplicate rule id \`${doc.id}\``)
    seenIds.add(doc.id)
    rules.push({
      id: doc.id,
      version: doc.version,
      title: doc.title,
      description: doc.description ?? "",
      file: `rules/${name}`,
      sha256: createHash("sha256").update(bodyBytes).digest("hex"),
      size: bodyBytes.length,
    })
  }
  return { schemaVersion: SCHEMA_VERSION, updatedAt: now(), rules }
}

/** payload 比较：忽略 updatedAt（时间戳不是业务数据）。 */
export function samePayload(a, b) {
  if (!a || !b) return false
  const { updatedAt: _a, ...restA } = a
  const { updatedAt: _b, ...restB } = b
  return JSON.stringify(restA) === JSON.stringify(restB)
}

/** 只读校验：现有 rules.json 必须与纯计算结果一致。 */
export function checkRulesIndex({ entries, existing, now }) {
  const computed = buildRulesIndex({ entries, now })
  if (!existing) return { ok: false, computed, problems: ["rules.json does not exist"] }
  const problems = []
  if (existing.schemaVersion !== computed.schemaVersion) {
    problems.push(`schemaVersion mismatch (existing ${existing.schemaVersion}, expected ${computed.schemaVersion})`)
  }
  const existingIds = (existing.rules ?? []).map((rule) => rule.id)
  const computedIds = computed.rules.map((rule) => rule.id)
  if (JSON.stringify(existingIds) !== JSON.stringify(computedIds)) {
    problems.push(`rule set mismatch (existing [${existingIds.join(", ")}], expected [${computedIds.join(", ")}])`)
  }
  for (const rule of computed.rules) {
    const current = (existing.rules ?? []).find((entry) => entry.id === rule.id)
    if (!current) continue
    for (const field of ["sha256", "size", "version", "file"]) {
      if (current[field] !== rule[field]) {
        problems.push(
          `${rule.id}: ${field} mismatch (existing ${JSON.stringify(current[field])}, expected ${JSON.stringify(rule[field])})`,
        )
      }
    }
  }
  return { ok: problems.length === 0, computed, problems }
}

export function ruleSourceFiles(market = MARKET) {
  const rulesDir = join(market, "rules")
  if (!existsSync(rulesDir)) throw new RuleError("no rules/ directory")
  const files = readdirSync(rulesDir).filter((name) => name.endsWith(".json"))
  if (files.length === 0) throw new RuleError("rules/ contains no .json source")
  return files.map((name) => ({ name, body: readFileSync(join(rulesDir, name), "utf8") }))
}

function defaultNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z")
}

function main() {
  const checkOnly = process.argv.includes("--check")
  try {
    const entries = ruleSourceFiles()
    const existingRaw = existsSync(RULES_INDEX_PATH) ? readFileSync(RULES_INDEX_PATH, "utf8") : null
    const existing = existingRaw === null ? null : JSON.parse(existingRaw)

    if (checkOnly) {
      const result = checkRulesIndex({ entries, existing, now: defaultNow })
      if (!result.ok) {
        console.error("[login-rule-market] rules.json is out of date:")
        for (const problem of result.problems) console.error(`  - ${problem}`)
        console.error("hint: run `node scripts/build-rules.mjs` to regenerate, then commit.")
        process.exit(1)
      }
      console.log(`[login-rule-market] rules.json up to date (${result.computed.rules.length} rule(s)).`)
      return
    }

    const computed = buildRulesIndex({ entries, now: defaultNow })
    const next = samePayload(existing, computed) ? { ...computed, updatedAt: existing.updatedAt } : computed
    const temp = join(dirname(RULES_INDEX_PATH), `.${process.pid}.rules.tmp`)
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n")
    renameSync(temp, RULES_INDEX_PATH)
    console.log(
      `[login-rule-market] rules.json written (${computed.rules.length} rule(s))${
        samePayload(existing, computed) ? " — payload unchanged, updatedAt preserved" : ""
      }`,
    )
  } catch (error) {
    console.error(`[login-rule-market] ${error.message}`)
    process.exit(1)
  }
}

main()
