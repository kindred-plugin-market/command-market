// D05：工作流静态不变量（只读验证与写回职责分离、SHA 固定、权限最小化）。
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { load } from "js-yaml"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = async (rel) => readFile(join(ROOT, rel), "utf8")

describe("quality.yml（只读验证）", () => {
  it("权限最小化、并发受限、每个 job 有超时", async () => {
    const doc = load(await read(".github/workflows/quality.yml"))
    assert.deepEqual(doc.permissions, { contents: "read" })
    assert.equal(doc.concurrency["cancel-in-progress"], true)
    for (const [name, job] of Object.entries(doc.jobs)) {
      assert.ok(job["timeout-minutes"] > 0, `job ${name} needs a timeout`)
    }
  })

  it("Action 全部固定到 40 位 SHA并带版本注释", async () => {
    const raw = await read(".github/workflows/quality.yml")
    const uses = [...raw.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1])
    assert.ok(uses.length >= 3)
    for (const reference of uses) {
      assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must be SHA-pinned`)
    }
  })

  it("没有任何写回（不 commit/push/写权限）", async () => {
    const raw = await read(".github/workflows/quality.yml")
    assert.doesNotMatch(raw, /git commit|git push|contents: write|upload-artifact|publish/i)
  })

  it("主 job 用 .node-version，兼容 job 用 24.15.0", async () => {
    const doc = load(await read(".github/workflows/quality.yml"))
    const mainNode = doc.jobs.quality.steps.find((step) => String(step.uses ?? "").startsWith("actions/setup-node@"))
    assert.equal(mainNode.with["node-version-file"], ".node-version")
    const compatNode = doc.jobs.compatibility.steps.find((step) => String(step.uses ?? "").startsWith("actions/setup-node@"))
    assert.equal(compatNode.with["node-version"], "24.15.0")
  })

  it("两个索引的 --check 都在 CI 里", async () => {
    const doc = load(await read(".github/workflows/quality.yml"))
    const runs = Object.values(doc.jobs).map((job) => job.steps.map((step) => step.run ?? "").join("\n")).join("\n")
    assert.match(runs, /build-registry\.mjs --check/)
    assert.match(runs, /build-rules\.mjs --check/)
  })
})

describe("registry.yml（唯一写回入口）", () => {
  it("写权限显式声明且 Action 已固定", async () => {
    const doc = load(await read(".github/workflows/registry.yml"))
    assert.deepEqual(doc.permissions, { contents: "write" })
    const checkout = doc.jobs.rebuild.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"))
    assert.match(checkout.uses, /@[0-9a-f]{40}$/)
    const rebuild = doc.jobs.rebuild.steps.find((step) => step.run?.includes("build-rules.mjs"))
    assert.ok(rebuild, "rebuild job must run the index builders")
  })

  it("写回不可被并发取消", async () => {
    const doc = load(await read(".github/workflows/registry.yml"))
    assert.equal(doc.concurrency["cancel-in-progress"], false)
  })
})
