// 两索引一致性（D03）：registry.json / rules.json 必须与其源文件一致——
// 每个条目的 sha256/size 用真实字节重算，集合不允许漏项。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

function verifyIndex(indexFile, sourceDir, items) {
  const problems = []
  const sourceNames = new Set()
  for (const item of items) {
    const path = join(ROOT, item.file)
    let body
    try {
      body = readFileSync(path)
    } catch {
      problems.push(`${item.file}: indexed but missing on disk`)
      continue
    }
    sourceNames.add(item.file)
    const sha256 = createHash("sha256").update(body).digest("hex")
    if (sha256 !== item.sha256) problems.push(`${item.file}: sha256 mismatch`)
    if (body.length !== item.size) problems.push(`${item.file}: size mismatch`)
  }
  for (const name of [...sourceNames].sort()) {
    const rel = name.split("/").slice(0, -1).join("/")
    assert.equal(rel, sourceDir, "index paths must stay inside their source directory")
  }
  return problems
}

describe("两索引与源文件一致", () => {
  it("registry.json 与 commands/*.json 一致", () => {
    const index = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
    const problems = verifyIndex("registry.json", "commands", index.commands)
    assert.deepEqual(problems, [])
    assert.equal(index.commands.length, 3, "命令市场当前应为 3 个命令")
  })

  it("rules.json 与 rules/*.json 一致", () => {
    const index = JSON.parse(readFileSync(join(ROOT, "rules.json"), "utf8"))
    const problems = verifyIndex("rules.json", "rules", index.rules)
    assert.deepEqual(problems, [])
    assert.equal(index.rules.length, 3, "规则市场当前应为 3 条规则")
  })

  it("两索引互不交叉（file 路径不越目录）", () => {
    const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
    const rules = JSON.parse(readFileSync(join(ROOT, "rules.json"), "utf8"))
    for (const item of registry.commands) assert.match(item.file, /^commands\//)
    for (const item of rules.rules) assert.match(item.file, /^rules\//)
  })
})
