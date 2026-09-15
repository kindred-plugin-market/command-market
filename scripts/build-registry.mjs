#!/usr/bin/env node
/**
 * command-market 命令索引（D02）：扫描 commands/*.json，纯计算 registry，
 * 显式写入或 `--check` 只读校验。
 *
 * 三个阶段分离（03 §3 D02）：
 *   纯计算  buildRegistry({files})        — 无 IO 副作用，坏输入/重复 id 直接抛错
 *   只读    --check                        — 比对 schema/集合/id/hash/size，绝不写
 *   显式写  （默认）                        — 原子写 registry.json；payload 未变时
 *                                          保留原 updatedAt（重复生成无时间漂移）
 *
 * 用法：node scripts/build-registry.mjs [--check]
 * 在 Bench 宿主中的消费契约见本仓库 README.md。**绝不执行卡片中的 command。**
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_ROOT = dirname(fileURLToPath(import.meta.url))
// 测试/工具可通过 BENCH_COMMAND_MARKET_DIR 覆盖仓库根（默认：脚本所在仓库）。
const MARKET = process.env.BENCH_COMMAND_MARKET_DIR
  ? resolve(process.env.BENCH_COMMAND_MARKET_DIR)
  : join(SCRIPT_ROOT, "..")
const COMMANDS_DIR = join(MARKET, "commands")
const REGISTRY_PATH = join(MARKET, "registry.json")
const SCHEMA_VERSION = 1
const REQUIRED_FIELDS = ["schemaVersion", "id", "version", "title", "kind", "command"]
const KINDS = ["shell", "shellAdmin", "copy", "open"]

export class RegistryError extends Error {
  constructor(message) {
    super(message)
    this.name = "RegistryError"
  }
}

/** 纯计算：从命令源文件构建 registry 文档。只读输入，绝不写文件。 */
export function buildRegistry({ entries, now = defaultNow }) {
  const commands = []
  const seenIds = new Set()
  for (const { name, body } of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    let doc
    try {
      doc = JSON.parse(body)
    } catch (error) {
      throw new RegistryError(`${name}: invalid JSON (${error.message})`)
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new RegistryError(`${name}: must be a JSON object`)
    }
    for (const field of REQUIRED_FIELDS) {
      if (doc[field] === undefined || doc[field] === "") {
        throw new RegistryError(`${name}: missing required field \`${field}\``)
      }
    }
    if (doc.schemaVersion !== SCHEMA_VERSION) {
      throw new RegistryError(`${name}: schemaVersion must be ${SCHEMA_VERSION}`)
    }
    if (!/^[a-z][a-z0-9-]*$/.test(doc.id)) {
      throw new RegistryError(`${name}: id \`${doc.id}\` must match ^[a-z][a-z0-9-]*$`)
    }
    if (!/^\d+\.\d+\.\d+$/.test(doc.version)) {
      throw new RegistryError(`${name}: version \`${doc.version}\` must be X.Y.Z`)
    }
    if (!KINDS.includes(doc.kind)) {
      throw new RegistryError(`${name}: kind \`${doc.kind}\` is invalid (expected one of ${KINDS.join(", ")})`)
    }
    if (seenIds.has(doc.id)) {
      throw new RegistryError(`duplicate command id \`${doc.id}\``)
    }
    seenIds.add(doc.id)
    const bodyBytes = Buffer.from(body, "utf8")
    commands.push({
      id: doc.id,
      version: doc.version,
      title: doc.title,
      description: doc.description ?? "",
      kind: doc.kind,
      file: `commands/${name}`,
      sha256: createHash("sha256").update(bodyBytes).digest("hex"),
      size: bodyBytes.length,
    })
  }
  return { schemaVersion: SCHEMA_VERSION, updatedAt: now(), commands }
}

/** payload 比较：忽略 updatedAt（时间戳不是业务数据）。 */
export function samePayload(a, b) {
  if (!a || !b) return false
  const { updatedAt: _a, ...restA } = a
  const { updatedAt: _b, ...restB } = b
  return JSON.stringify(restA) === JSON.stringify(restB)
}

/** 只读校验：现有 registry.json 必须与纯计算结果一致。返回诊断，不写任何文件。 */
export function checkRegistry({ entries, existing, now }) {
  const computed = buildRegistry({ entries, now })
  if (!existing) return { ok: false, computed, problems: ["registry.json does not exist"] }
  const problems = []
  if (existing.schemaVersion !== computed.schemaVersion) {
    problems.push(`schemaVersion mismatch (existing ${existing.schemaVersion}, expected ${computed.schemaVersion})`)
  }
  const existingIds = (existing.commands ?? []).map((command) => command.id)
  const computedIds = computed.commands.map((command) => command.id)
  if (JSON.stringify(existingIds) !== JSON.stringify(computedIds)) {
    problems.push(`command set mismatch (existing [${existingIds.join(", ")}], expected [${computedIds.join(", ")}])`)
  }
  for (const command of computed.commands) {
    const current = (existing.commands ?? []).find((entry) => entry.id === command.id)
    if (!current) continue
    for (const field of ["sha256", "size", "version", "kind", "file"]) {
      if (current[field] !== command[field]) {
        problems.push(`${command.id}: ${field} mismatch (existing ${JSON.stringify(current[field])}, expected ${JSON.stringify(command[field])})`)
      }
    }
  }
  return { ok: problems.length === 0, computed, problems }
}

function defaultNow() {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z")
}

function sourceFiles() {
  if (!existsSync(COMMANDS_DIR)) {
    throw new RegistryError("no commands/ directory")
  }
  const files = readdirSync(COMMANDS_DIR).filter((name) => name.endsWith(".json"))
  if (files.length === 0) {
    throw new RegistryError("commands/ contains no .json source")
  }
  return files
}

function main() {
  const checkOnly = process.argv.includes("--check")
  try {
    const entries = sourceFiles().map((name) => ({ name, body: readFileSync(join(COMMANDS_DIR, name), "utf8") }))
    const existingRaw = existsSync(REGISTRY_PATH) ? readFileSync(REGISTRY_PATH, "utf8") : null
    const existing = existingRaw === null ? null : JSON.parse(existingRaw)

    if (checkOnly) {
      const result = checkRegistry({ entries, existing, now: defaultNow })
      if (!result.ok) {
        console.error(`[command-market] registry.json is out of date:`)
        for (const problem of result.problems) console.error(`  - ${problem}`)
        console.error(`hint: run \`node scripts/build-registry.mjs\` to regenerate, then commit.`)
        process.exit(1)
      }
      console.log(`[command-market] registry.json up to date (${result.computed.commands.length} command(s)).`)
      return
    }

    const computed = buildRegistry({ entries, now: defaultNow })
    // payload 未变 → 保留原 updatedAt：重复生成不再产生时间漂移（R5）。
    const next = samePayload(existing, computed) ? { ...computed, updatedAt: existing.updatedAt } : computed
    const temp = join(dirname(REGISTRY_PATH), `.${process.pid}.registry.tmp`)
    writeFileSync(temp, JSON.stringify(next, null, 2) + "\n")
    renameSync(temp, REGISTRY_PATH)
    console.log(
      `[command-market] registry.json written (${computed.commands.length} command(s))${
        samePayload(existing, computed) ? " — payload unchanged, updatedAt preserved" : ""
      }`,
    )
  } catch (error) {
    console.error(`[command-market] ${error.message}`)
    process.exit(1)
  }
}

main()
