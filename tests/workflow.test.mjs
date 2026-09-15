// D05 / D07.1：工作流静态不变量。
//
// 模型（D07.1 选定）：**索引是 PR 的一部分，仓库里没有任何写回入口**。
// D07 曾经用 `needs` 把写回绑定到同 SHA 门禁，但门禁里的 `--check` 要求索引已与
// 源一致 → 「需要重建」的输入永远到不了写回 job，形成循环门禁。这些用例把选定
// 模型固化成可执行约束：工作流集合、只读权限、以及 stale 索引的可执行失败路径。
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"
import { load } from "js-yaml"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = async (rel) => readFile(join(ROOT, rel), "utf8")
const WORKFLOW_DIR = join(ROOT, ".github", "workflows")

const workflowFiles = async () =>
  (await readdir(WORKFLOW_DIR)).filter((name) => /\.ya?ml$/.test(name)).sort()

describe("工作流集合（D07.1：只读模型，无写回入口）", () => {
  it("只有 quality.yml：新增工作流必须显式更新这条不变量", async () => {
    assert.deepEqual(
      await workflowFiles(),
      ["quality.yml"],
      "任何新的工作流（尤其写回/发布）都必须先在这里被显式承认，不能悄悄出现",
    )
  })

  it("任何工作流都不持有写权限，也不 commit/push", async () => {
    for (const file of await workflowFiles()) {
      const raw = await read(`.github/workflows/${file}`)
      assert.doesNotMatch(raw, /git commit|git push|contents:\s*write/, `${file} 必须保持只读`)
      assert.doesNotMatch(raw, /permissions:\s*write/)
      const doc = load(raw)
      assert.deepEqual(doc.permissions, { contents: "read" }, `${file} 必须声明 contents: read`)
    }
  })

  it("README 描述的模型与工作流一致", async () => {
    const readme = await read("README.md")
    assert.match(readme, /没有任何写回入口/, "README 必须写明没有写回入口")
    assert.match(readme, /PR/, "README 必须写明索引随 PR 提交")
    assert.doesNotMatch(readme, /registry\.yml/, "README 不得再引用已删除的写回工作流")
  })
})

describe("quality.yml（唯一工作流：只读验证）", () => {
  it("权限最小化、并发受限、每个 job 有超时", async () => {
    const doc = load(await read(".github/workflows/quality.yml"))
    assert.deepEqual(doc.permissions, { contents: "read" })
    assert.equal(doc.concurrency["cancel-in-progress"], true)
    for (const [name, job] of Object.entries(doc.jobs)) {
      assert.ok(job["timeout-minutes"] > 0, `job ${name} needs a timeout`)
    }
  })

  it("Action 全部固定到 40 位 SHA 并带版本注释", async () => {
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
    const runs = Object.values(doc.jobs)
      .map((job) => job.steps.map((step) => step.run ?? "").join("\n"))
      .join("\n")
    assert.match(runs, /build-registry\.mjs --check/)
    assert.match(runs, /build-rules\.mjs --check/)
  })

  it("stale 索引的失败文案必须可执行（PR 模型的前提）", async () => {
    // 既然没有写回 job，失败信息就必须自己给出下一步动作，否则贡献者只能猜。
    for (const [script, indexFile, envVar] of [
      ["build-registry.mjs", "registry.json", "BENCH_COMMAND_MARKET_DIR"],
      ["build-rules.mjs", "rules.json", "BENCH_RULES_MARKET_DIR"],
    ]) {
      const source = await read(`scripts/${script}`)
      assert.match(source, /hint: run/, `${script} 必须打印重算命令`)
      assert.ok(source.includes(`node scripts/${script}`), `${script} 的 hint 必须指向自己`)
      assert.ok(source.includes(indexFile), `${script} 必须校验 ${indexFile}`)
      assert.ok(source.includes(envVar), `${script} 必须支持 ${envVar} 覆盖（负向测试依赖它）`)
    }
  })
})
