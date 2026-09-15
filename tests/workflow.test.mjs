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

/* D07：把「job needs + if 成功门禁」翻译成可断言的语义，而不是比对字符串。
 *
 * 没有 needs 的写回 job 在任何输入下都会执行（下面的负向 fixture 就是这么写的）；
 * 有 needs 但缺 `if: needs.<job>.result == 'success'` 时，GitHub 会等 needs 结束，
 * 但 needs 失败/取消/跳过时仍会**跳过**该 job —— 两种形态都要能区分，所以模型返回
 * 「这条 run 会不会真的写回」。 */
const SUCCESS_GATE_RE = /needs\.([A-Za-z0-9_-]+)\.result\s*==\s*["']success["']/g

function writeBackRuns(doc, results, jobName = "rebuild") {
  const job = doc.jobs[jobName]
  const needs = [].concat(job.needs ?? [])
  if (needs.length === 0) return true
  const gates = [...String(job.if ?? "").matchAll(SUCCESS_GATE_RE)].map((match) => match[1])
  if (gates.length === 0) return needs.every((name) => results[name] === "success")
  return gates.every((name) => needs.includes(name) && results[name] === "success")
}

describe("registry.yml（唯一写回入口）", () => {
  it("权限最小化：顶层只读，写权限只给 rebuild job", async () => {
    const doc = load(await read(".github/workflows/registry.yml"))
    assert.deepEqual(doc.permissions, { contents: "read" })
    assert.deepEqual(doc.jobs.verify.permissions, { contents: "read" })
    assert.deepEqual(doc.jobs.rebuild.permissions, { contents: "write" })
  })

  it("Action 全部固定到 40 位 SHA，每个 job 有超时", async () => {
    const raw = await read(".github/workflows/registry.yml")
    const uses = [...raw.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1])
    assert.ok(uses.length >= 3)
    for (const reference of uses) {
      assert.match(reference, /@[0-9a-f]{40}$/, `${reference} must be SHA-pinned`)
    }
    const doc = load(raw)
    for (const [name, job] of Object.entries(doc.jobs)) {
      assert.ok(job["timeout-minutes"] > 0, `job ${name} needs a timeout`)
    }
  })

  it("只读门禁 job 先跑索引一致性与全量测试", async () => {
    const doc = load(await read(".github/workflows/registry.yml"))
    const runs = doc.jobs.verify.steps.map((step) => step.run ?? "").join("\n")
    assert.match(runs, /build-registry\.mjs --check/)
    assert.match(runs, /build-rules\.mjs --check/)
    assert.match(runs, /pnpm test/)
    assert.doesNotMatch(runs, /git (commit|push)|contents: write/)
  })

  it("写回只在同 run 的门禁成功后才可能发生", async () => {
    const doc = load(await read(".github/workflows/registry.yml"))
    assert.deepEqual([].concat(doc.jobs.rebuild.needs), ["verify"])
    assert.match(String(doc.jobs.rebuild.if), /needs\.verify\.result\s*==\s*'success'/)

    assert.equal(writeBackRuns(doc, { verify: "success" }), true, "门禁绿 → 允许写回")
    for (const result of ["failure", "cancelled", "skipped"]) {
      assert.equal(writeBackRuns(doc, { verify: result }), false, `verify=${result} 时必须跳过写回`)
    }
  })

  it("负向 fixture：D07 之前「无 needs」的写回 job 在任何输入下都会写", async () => {
    let regressed
    assert.doesNotThrow(() => {
      regressed = load(`name: Registry
on:
  push:
    branches: [main]
permissions:
  contents: write
concurrency:
  group: registry-writeback
  cancel-in-progress: false
jobs:
  rebuild:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: node scripts/build-registry.mjs
`)
    })
    assert.equal(
      writeBackRuns(regressed, { quality: "failure" }),
      true,
      "没有 needs 的写回 job 无法被质量结果约束——这就是 run 34915374485 绿而 quality 34915374475 红的形态",
    )
  })

  it("写回绑定被验证的 SHA，并在 main 前移时失败退出", async () => {
    const doc = load(await read(".github/workflows/registry.yml"))
    const checkout = doc.jobs.rebuild.steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    )
    assert.equal(checkout.with.ref, "${{ github.sha }}", "写回必须从被验证的 SHA 开工，而不是浮动的 main")
    const commit = doc.jobs.rebuild.steps.find((step) => step.run?.includes("git commit"))
    assert.ok(commit, "rebuild job must commit the refreshed indexes")
    assert.match(commit.run, /git fetch .*origin main/, "写回前必须重新取回远端 main")
    assert.match(commit.run, /VALIDATED_SHA/, "要被验证的 SHA 显式参与判断")
    assert.match(commit.run, /exit 1/, "远端前移时失败退出，不做无界重试")
    assert.match(commit.run, /git push origin HEAD:main/)
    assert.match(String(commit.env?.VALIDATED_SHA ?? ""), /github\.sha/)
  })

  it("写回不可被并发取消", async () => {
    const doc = load(await read(".github/workflows/registry.yml"))
    assert.equal(doc.concurrency["cancel-in-progress"], false)
  })
})
