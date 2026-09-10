#!/usr/bin/env node
/**
 * login-rule 索引构建脚本：扫描 rules/*.json（站点登录判定规则包），
 * 逐文件按 spec fail-closed 校验后计算 sha256 + size，重写 rules.json
 * （确定性排序，diff 友好）。与 commands/ 命令市场体系相互独立：
 * 命令索引 registry.json / 规则索引 rules.json 各自独立演进 schemaVersion，
 * 老客户端不受规则板块影响。
 *
 * 校验规则与 Bench 宿主（src-tauri/src/account_manager/login_rules.rs）一致，
 * 规格见 Bench 仓库 docs/reference/login-rulepack-spec.md。
 *
 * 发布流程：新增/修改 rules/*.json → node scripts/build-rules.mjs → git commit。
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const MARKET = process.cwd()
const RULES_DIR = join(MARKET, "rules")
const RULES_INDEX_PATH = join(MARKET, "rules.json")
const SCHEMA_VERSION = 1

// 通用兜底规则 id（非域名）：match 必须省略（全局生效）、禁止 loginCheck
//（通用规则无法预知各站点同域鉴权接口）、必须提供 fallback。站点特殊规则优先于它。
const GENERIC_ID = "generic"

// 与宿主 serde deny_unknown_fields 对齐的已知字段白名单。
const KNOWN = {
  rule: ["schemaVersion", "id", "version", "title", "description", "match", "detection"],
  match: ["registrableDomain", "hosts"],
  detection: ["loginCheck", "fallback"],
  loginCheck: ["url", "method", "expect", "prerequisiteCookies"],
  expect: ["kind", "path", "loggedIn", "loggedOut"],
  fallback: ["loggedIn", "loggedOut"],
  condition: ["kind", "value", "presence"],
}

const fail = (name, msg) => {
  console.error(`[login-rule-market] ${name}: ${msg}`)
  process.exit(1)
}

const unknownFields = (obj, allowed) =>
  Object.keys(obj).filter((k) => !allowed.includes(k))

const isRegistrableDomain = (v) =>
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)

const isHost = (v) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)

const sameRegistrableDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`)

const isSemver = (v) => /^\d+\.\d+\.\d+$/.test(v)

function validateExpect(name, expect) {
  const extra = unknownFields(expect, KNOWN.expect)
  if (extra.length) fail(name, `expect has unknown field(s): ${extra.join(", ")}`)
  if (!["status", "jsonBool", "bodyContains"].includes(expect.kind))
    fail(name, `expect.kind \`${expect.kind}\` is invalid (status | jsonBool | bodyContains)`)
  if (expect.kind === "jsonBool") {
    if (!/^[A-Za-z0-9_.]+$/.test(expect.path ?? ""))
      fail(name, `expect.path must match ^[A-Za-z0-9_.]+$`)
    return
  }
  for (const side of ["loggedIn", "loggedOut"]) {
    const list = expect[side]
    if (!Array.isArray(list) || list.length === 0)
      fail(name, `expect.${side} must be a non-empty array for kind \`${expect.kind}\``)
    for (const item of list) {
      if (expect.kind === "status") {
        if (!Number.isInteger(item) || item < 100 || item > 599)
          fail(name, `expect.${side} contains invalid HTTP status ${JSON.stringify(item)}`)
      } else if (typeof item !== "string" || item.length === 0) {
        fail(name, `expect.${side} must contain non-empty strings`)
      }
    }
  }
}

function validateLoginCheck(name, domain, check) {
  const extra = unknownFields(check, KNOWN.loginCheck)
  if (extra.length) fail(name, `loginCheck has unknown field(s): ${extra.join(", ")}`)
  if (!["GET", "POST"].includes(check.method))
    fail(name, `loginCheck.method must be GET or POST`)
  let url
  try {
    url = new URL(check.url)
  } catch {
    fail(name, `loginCheck.url is not a valid URL`)
  }
  if (url.protocol !== "https:") fail(name, `loginCheck.url must be https`)
  if (!sameRegistrableDomain(url.hostname, domain))
    fail(name, `loginCheck.url host \`${url.hostname}\` must share registrable domain \`${domain}\` (same-domain rule)`)
  validateExpect(name, check.expect)
  if (check.prerequisiteCookies !== undefined) {
    if (!Array.isArray(check.prerequisiteCookies) || check.prerequisiteCookies.length === 0)
      fail(name, `loginCheck.prerequisiteCookies must be a non-empty array`)
    for (const c of check.prerequisiteCookies) {
      if (typeof c !== "string" || c.length === 0)
        fail(name, `loginCheck.prerequisiteCookies must contain non-empty strings`)
    }
  }
}

function validateCondition(name, side, cond) {
  const extra = unknownFields(cond, KNOWN.condition)
  if (extra.length) fail(name, `fallback.${side} condition has unknown field(s): ${extra.join(", ")}`)
  if (!["text", "selector"].includes(cond.kind))
    fail(name, `fallback.${side} condition kind \`${cond.kind}\` is invalid (text | selector)`)
  if (typeof cond.value !== "string" || cond.value.trim().length === 0)
    fail(name, `fallback.${side} condition value must be a non-empty string`)
  if (cond.value.length > 200) fail(name, `fallback.${side} condition value must be <= 200 chars`)
  if (cond.presence !== undefined && !["present", "absent"].includes(cond.presence))
    fail(name, `fallback.${side} condition presence \`${cond.presence}\` is invalid`)
  if (cond.presence !== undefined && cond.presence !== "present" && cond.kind !== "text")
    fail(name, `fallback.${side}: presence=absent is only valid for kind=text`)
}

function validateFallback(name, fallback) {
  const extra = unknownFields(fallback, KNOWN.fallback)
  if (extra.length) fail(name, `fallback has unknown field(s): ${extra.join(", ")}`)
  for (const side of ["loggedIn", "loggedOut"]) {
    const list = fallback[side]
    if (list === undefined) continue
    if (!Array.isArray(list)) fail(name, `fallback.${side} must be an array`)
    for (const cond of list) validateCondition(name, side, cond)
  }
}

function validateRule(name, fileBase, body) {
  const extra = unknownFields(body, KNOWN.rule)
  if (extra.length) fail(name, `unknown field(s): ${extra.join(", ")}`)
  if (body.schemaVersion !== SCHEMA_VERSION) fail(name, `schemaVersion must be ${SCHEMA_VERSION}`)
  const isGeneric = body.id === GENERIC_ID
  if (!isGeneric && !isRegistrableDomain(body.id ?? ""))
    fail(name, `id \`${body.id}\` is not a valid registrable domain`)
  if (body.id !== fileBase) fail(name, `id \`${body.id}\` must equal file name (without .json)`)
  if (!isSemver(body.version ?? "")) fail(name, `version \`${body.version}\` must be X.Y.Z`)
  if (typeof body.title !== "string" || body.title.trim().length === 0)
    fail(name, `title must be a non-empty string`)

  const match = body.match
  if (isGeneric) {
    if (match !== undefined) fail(name, `generic rule must not define match (applies globally)`)
  } else {
    if (!match || typeof match !== "object") fail(name, `match is required`)
    const matchExtra = unknownFields(match, KNOWN.match)
    if (matchExtra.length) fail(name, `match has unknown field(s): ${matchExtra.join(", ")}`)
    if (match.registrableDomain !== body.id)
      fail(name, `match.registrableDomain must equal id \`${body.id}\``)
    if (match.hosts !== undefined) {
      if (!Array.isArray(match.hosts)) fail(name, `match.hosts must be an array`)
      for (const host of match.hosts) {
        if (!isHost(host)) fail(name, `match.hosts entry \`${host}\` is not a valid host`)
        if (!sameRegistrableDomain(host, body.id))
          fail(name, `match.hosts entry \`${host}\` must share registrable domain \`${body.id}\``)
      }
    }
  }

  const detection = body.detection
  if (!detection || typeof detection !== "object") fail(name, `detection is required`)
  const detExtra = unknownFields(detection, KNOWN.detection)
  if (detExtra.length) fail(name, `detection has unknown field(s): ${detExtra.join(", ")}`)
  if (detection.loginCheck === undefined && detection.fallback === undefined)
    fail(name, `detection must define loginCheck and/or fallback`)
  if (isGeneric) {
    if (detection.loginCheck !== undefined)
      fail(
        name,
        `generic rule must not define loginCheck (same-domain rule cannot apply globally)`
      )
    if (detection.fallback === undefined) fail(name, `generic rule must define fallback`)
  }
  if (detection.loginCheck !== undefined) validateLoginCheck(name, body.id, detection.loginCheck)
  if (detection.fallback !== undefined) validateFallback(name, detection.fallback)
}

function main() {
  if (!existsSync(RULES_DIR)) {
    console.error("[login-rule-market] no rules/ directory")
    process.exit(1)
  }

  const files = readdirSync(RULES_DIR).filter((name) => name.endsWith(".json")).sort()

  const rules = []
  const seenIds = new Set()
  for (const name of files) {
    const path = join(RULES_DIR, name)
    const body = readFileSync(path)
    let doc
    try {
      doc = JSON.parse(body.toString("utf8"))
    } catch (error) {
      fail(name, `invalid JSON (${error.message})`)
    }
    validateRule(name, name.replace(/\.json$/, ""), doc)
    if (seenIds.has(doc.id)) fail(name, `duplicate rule id \`${doc.id}\``)
    seenIds.add(doc.id)
    rules.push({
      id: doc.id,
      version: doc.version,
      title: doc.title,
      description: doc.description ?? "",
      file: `rules/${name}`,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
    })
  }

  const registry = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    rules,
  }
  writeFileSync(RULES_INDEX_PATH, JSON.stringify(registry, null, 2) + "\n")
  console.log(`[login-rule-market] rules.json written (${rules.length} rule(s))`)
}

main()
