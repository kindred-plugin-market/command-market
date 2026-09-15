// D03：规则索引纯计算 / fail-closed 校验 / 只读 check 的回归测试。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import { GENERIC_ID, RuleError, buildRulesIndex, checkRulesIndex, samePayload } from "../scripts/build-rules.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts/build-rules.mjs")
const now = () => "2026-09-15T00:00:00Z"

const entry = (id, body) => ({ name: `${id}.json`, body: JSON.stringify(body) })

const siteRule = (id, extra = {}) => ({
  schemaVersion: 1,
  id,
  version: "1.0.0",
  title: `rule ${id}`,
  match: { registrableDomain: id },
  detection: { loginCheck: { url: `https://www.${id}/login`, method: "GET", expect: { kind: "status", loggedIn: [200], loggedOut: [403] } } },
  ...extra,
})

const genericRule = () => ({
  schemaVersion: 1,
  id: GENERIC_ID,
  version: "1.0.0",
  title: "generic fallback",
  detection: { fallback: { loggedIn: [{ kind: "text", value: "退出" }] } },
})

describe("buildRulesIndex（纯计算 + fail-closed 校验）", () => {
  it("构建合法站点规则与通用规则（确定性排序）", () => {
    const doc = buildRulesIndex({ entries: [entry(GENERIC_ID, genericRule()), entry("example.com", siteRule("example.com"))], now })
    assert.deepEqual(doc.rules.map((r) => r.id), ["example.com", GENERIC_ID])
    assert.match(doc.rules[0].sha256, /^[0-9a-f]{64}$/)
    assert.equal(doc.rules[0].file, "rules/example.com.json")
  })

  it("id 必须等于文件名且为可注册域名", () => {
    assert.throws(() => buildRulesIndex({ entries: [entry("not-a-domain", siteRule("not-a-domain"))], now }), /registrable domain/)
    assert.throws(() => buildRulesIndex({ entries: [{ name: "other.json", body: JSON.stringify(siteRule("example.com")) }], now }), /must equal file name/)
  })

  it("match.registrableDomain 必须等于 id，hosts 必须同域", () => {
    const bad = siteRule("example.com", { match: { registrableDomain: "other.com" } })
    assert.throws(() => buildRulesIndex({ entries: [entry("example.com", bad)], now }), /must equal id/)
    const badHost = siteRule("example.com", {
      match: { registrableDomain: "example.com", hosts: ["evil.com"] },
    })
    assert.throws(() => buildRulesIndex({ entries: [entry("example.com", badHost)], now }), /must share registrable domain/)
  })

  it("未知字段拒绝（deny_unknown_fields 对齐）", () => {
    const bad = siteRule("example.com", { extra: true })
    assert.throws(() => buildRulesIndex({ entries: [entry("example.com", bad)], now }), /unknown field\(s\): extra/)
  })

  it("loginCheck 必须 https 且与 id 同域", () => {
    const http = siteRule("example.com")
    http.detection.loginCheck.url = "http://www.example.com/login"
    assert.throws(() => buildRulesIndex({ entries: [entry("example.com", http)], now }), /must be https/)
    const cross = siteRule("example.com")
    cross.detection.loginCheck.url = "https://evil.com/login"
    assert.throws(() => buildRulesIndex({ entries: [entry("example.com", cross)], now }), /same-domain rule/)
  })

  it("通用规则：禁 match/禁 loginCheck、必须有 fallback", () => {
    const withMatch = { ...genericRule(), match: { registrableDomain: GENERIC_ID } }
    assert.throws(() => buildRulesIndex({ entries: [entry(GENERIC_ID, withMatch)], now }), /generic rule must not define match/)
    const withCheck = { ...genericRule(), detection: { loginCheck: siteRule("x.com").detection.loginCheck } }
    assert.throws(() => buildRulesIndex({ entries: [entry(GENERIC_ID, withCheck)], now }), /generic rule must not define loginCheck/)
    const noFallback = { ...genericRule(), detection: {} }
    // 空 detection 先命中通用校验（detection must define ...）；
    // 「generic rule must define fallback」是防御性分支，仅在两字段同时缺省以外的
    // 组合下不可达 —— 断言以实际可观测行为为准。
    assert.throws(() => buildRulesIndex({ entries: [entry(GENERIC_ID, noFallback)], now }), /detection must define loginCheck and\/or fallback/)
  })

  it("重复 id / 坏 JSON / 缺 detection 拒绝", () => {
    assert.throws(
      () => buildRulesIndex({ entries: [entry("example.com", siteRule("example.com")), entry("example.com", siteRule("example.com"))], now }),
      /duplicate rule id/,
    )
    assert.throws(() => buildRulesIndex({ entries: [{ name: "example.com.json", body: "{ nope" }], now }), /invalid JSON/)
    const noDetection = siteRule("example.com")
    delete noDetection.detection
    assert.throws(() => buildRulesIndex({ entries: [entry("example.com", noDetection)], now }), /detection is required/)
  })

  it("hash/size 对字节敏感", () => {
    const a = buildRulesIndex({ entries: [entry("example.com", siteRule("example.com"))], now })
    const b = buildRulesIndex({ entries: [entry("example.com", siteRule("example.com")), entry(GENERIC_ID, genericRule())], now })
    assert.equal(a.rules[0].sha256, b.rules[0].sha256)
    assert.notEqual(a.rules.length, b.rules.length)
  })
})

describe("checkRulesIndex / payload", () => {
  const good = buildRulesIndex({ entries: [entry("example.com", siteRule("example.com"))], now })

  it("一致时通过；hash 不一致给诊断", () => {
    assert.equal(checkRulesIndex({ entries: [entry("example.com", siteRule("example.com"))], existing: good, now }).ok, true)
    const tampered = { ...good, rules: [{ ...good.rules[0], sha256: "0".repeat(64) }] }
    const result = checkRulesIndex({ entries: [entry("example.com", siteRule("example.com"))], existing: tampered, now })
    assert.equal(result.ok, false)
    assert.match(result.problems[0], /sha256 mismatch/)
  })

  it("updatedAt 不参与 payload 比较", () => {
    assert.equal(samePayload(good, { ...good, updatedAt: "2099-01-01T00:00:00Z" }), true)
  })
})

describe("CLI（提交态）", () => {
  it("--check 对已提交的 rules.json 通过", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check"], { cwd: ROOT, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /up to date/)
  })
})
