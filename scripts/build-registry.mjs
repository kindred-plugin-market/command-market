#!/usr/bin/env node
/**
 * command-market 索引构建脚本：扫描 commands/*.json，
 * 逐文件计算 sha256 + size，重写 registry.json（确定性排序，diff 友好）。
 *
 * 发布流程：新增/修改 commands/*.json → node scripts/build-registry.mjs → git commit。
 * 在 Bench 宿主中的消费契约见本仓库 README.md。
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const MARKET = process.cwd()
const COMMANDS_DIR = join(MARKET, "commands")
const REGISTRY_PATH = join(MARKET, "registry.json")
const SCHEMA_VERSION = 1

function main() {
  if (!existsSync(COMMANDS_DIR)) {
    console.error("[command-market] no commands/ directory")
    process.exit(1)
  }

  const files = readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()

  const commands = []
  const seenIds = new Set()
  for (const name of files) {
    const body = readFileSync(join(COMMANDS_DIR, name))
    let doc
    try {
      doc = JSON.parse(body.toString("utf8"))
    } catch (error) {
      console.error(`[command-market] ${name}: invalid JSON (${error.message})`)
      process.exit(1)
    }
    for (const field of ["schemaVersion", "id", "version", "title", "kind", "command"]) {
      if (doc[field] === undefined || doc[field] === "") {
        console.error(`[command-market] ${name}: missing required field \`${field}\``)
        process.exit(1)
      }
    }
    if (doc.schemaVersion !== SCHEMA_VERSION) {
      console.error(`[command-market] ${name}: schemaVersion must be ${SCHEMA_VERSION}`)
      process.exit(1)
    }
    if (!/^[a-z][a-z0-9-]*$/.test(doc.id)) {
      console.error(`[command-market] ${name}: id \`${doc.id}\` must match ^[a-z][a-z0-9-]*$`)
      process.exit(1)
    }
    if (!/^\d+\.\d+\.\d+$/.test(doc.version)) {
      console.error(`[command-market] ${name}: version \`${doc.version}\` must be X.Y.Z`)
      process.exit(1)
    }
    if (!["shell", "shellAdmin", "copy", "open"].includes(doc.kind)) {
      console.error(`[command-market] ${name}: kind \`${doc.kind}\` is invalid`)
      process.exit(1)
    }
    if (seenIds.has(doc.id)) {
      console.error(`[command-market] duplicate command id \`${doc.id}\``)
      process.exit(1)
    }
    seenIds.add(doc.id)
    commands.push({
      id: doc.id,
      version: doc.version,
      title: doc.title,
      description: doc.description ?? "",
      kind: doc.kind,
      file: `commands/${name}`,
      sha256: createHash("sha256").update(body).digest("hex"),
      size: body.length,
    })
  }

  const registry = {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    commands,
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n")
  console.log(`[command-market] registry.json written (${commands.length} command(s))`)
}

main()
