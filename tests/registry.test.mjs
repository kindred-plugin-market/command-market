// D02：命令索引纯计算 / 只读 check 的回归测试。
// 覆盖：合法构建、重复 id、缺失字段、坏 JSON、非法 kind、payload 比较、
// hash/size/集合不匹配、以及提交态的 --check。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

import { RegistryError, buildRegistry, checkRegistry, samePayload } from "../scripts/build-registry.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts/build-registry.mjs")

const now = () => "2026-09-15T00:00:00Z"
const command = (id) =>
  JSON.stringify({ schemaVersion: 1, id, version: "1.0.0", title: id, kind: "shell", command: `echo ${id}` })

function entriesOf(entries) {
  return Object.entries(entries).map(([name, body]) => ({ name, body }))
}

describe("buildRegistry（纯计算）", () => {
  it("为合法命令生成确定性索引（排序 + sha256 + size）", () => {
    const doc = buildRegistry({
      entries: entriesOf({ "b.json": command("beta"), "a.json": command("alpha") }),
      now,
    })
    assert.deepEqual(doc.commands.map((c) => c.id), ["alpha", "beta"], "按文件名排序")
    assert.equal(doc.updatedAt, "2026-09-15T00:00:00Z")
    assert.equal(doc.commands[0].file, "commands/a.json")
    assert.match(doc.commands[0].sha256, /^[0-9a-f]{64}$/)
    assert.equal(doc.commands[0].size, Buffer.byteLength(command("alpha")))
  })

  it("拒绝重复 id / 缺字段 / 坏 JSON / 非法 kind", () => {
    assert.throws(() => buildRegistry({ entries: entriesOf({ "a.json": command("dup"), "b.json": command("dup") }), now }), /duplicate command id/)
    assert.throws(
      () => buildRegistry({ entries: entriesOf({ "a.json": JSON.stringify({ schemaVersion: 1, id: "x" }) }), now }),
      /missing required field/,
    )
    assert.throws(() => buildRegistry({ entries: entriesOf({ "a.json": "{ nope" }), now }), /invalid JSON/)
    assert.throws(
      () =>
        buildRegistry({
          entries: entriesOf({ "a.json": JSON.stringify({ schemaVersion: 1, id: "x", version: "1.0.0", title: "x", kind: "rm -rf", command: "x" }) }),
          now,
        }),
      /kind .* is invalid/,
    )
  })

  it("hash/size 按真实字节计算（改一字节即变化）", () => {
    const a = buildRegistry({ entries: entriesOf({ "a.json": command("x") }), now })
    const b = buildRegistry({ entries: entriesOf({ "a.json": command("x") + " " }), now })
    assert.notEqual(a.commands[0].sha256, b.commands[0].sha256)
    assert.notEqual(a.commands[0].size, b.commands[0].size)
  })
})

describe("checkRegistry（只读比对）", () => {
  const good = buildRegistry({ entries: entriesOf({ "a.json": command("alpha") }), now })

  it("payload 一致时通过", () => {
    const result = checkRegistry({ entries: entriesOf({ "a.json": command("alpha") }), existing: good, now })
    assert.equal(result.ok, true)
  })

  it("hash/size/集合不一致时给出诊断", () => {
    const tampered = { ...good, commands: [{ ...good.commands[0], sha256: "0".repeat(64), size: 1 }] }
    const result = checkRegistry({ entries: entriesOf({ "a.json": command("alpha") }), existing: tampered, now })
    assert.equal(result.ok, false)
    assert.match(result.problems[0], /sha256 mismatch/)
    assert.match(result.problems[1], /size mismatch/)
  })

  it("集合不一致（漏条目）给诊断", () => {
    const missing = { ...good, commands: [] }
    const result = checkRegistry({ entries: entriesOf({ "a.json": command("alpha") }), existing: missing, now })
    assert.equal(result.ok, false)
    assert.match(result.problems[0], /command set mismatch/)
  })

  it("updatedAt 不参与 payload 比较（时间戳稳定）", () => {
    const shifted = { ...good, updatedAt: "2099-01-01T00:00:00Z" }
    assert.equal(samePayload(good, shifted), true)
    const tampered = { ...good, commands: [] }
    assert.equal(samePayload(good, tampered), false)
  })
})

describe("CLI（提交态）", () => {
  it("--check 对已提交的 registry.json 通过", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check"], { cwd: ROOT, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /up to date/)
  })
})

describe("临时目录中的端到端", () => {
  it("写入后再 check 通过；payload 未变时 updatedAt 保留", () => {
    const dir = mkdtempSync(join(tmpdir(), "cmd-market-"))
    try {
      const commandsDir = join(dir, "commands")
      mkdirSync(commandsDir)
      writeFileSync(join(commandsDir, "a.json"), command("alpha"))
      const run = (arg) =>
        spawnSync(process.execPath, [SCRIPT, ...(arg ? [arg] : [])], {
          encoding: "utf8",
          env: { ...process.env, BENCH_COMMAND_MARKET_DIR: dir },
        })

      assert.equal(run().status, 0)
      const first = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"))
      assert.equal(run("--check").status, 0)
      writeFileSync(join(commandsDir, "a.json"), command("alpha")) // 原样重写
      assert.equal(run().status, 0)
      const second = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8"))
      assert.equal(second.updatedAt, first.updatedAt, "重复生成不得漂移时间戳")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})


