// D07.1 负向控制：PR 模型下「源改了但索引没更新」必须明确失败并可修复。
//
// 场景（审计指定）：修改一个 command/rule 源文件但不更新索引。
// 期望：`--check` 非零退出 + 可执行 hint，且**不存在**任何写回 job 兜底；
//      在同一次运行里按 hint 重算后必须通过（证明提示是可操作的）。
//
// 测试在临时目录里复现整条闭环（两个 builder 都支持 *_MARKET_DIR 覆盖仓库根），
// 真实仓库的索引文件从头到尾不得被改动。
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "node:test"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** 复现仓库局部结构：源文件目录 + 索引，然后篡改一个源文件（不动索引）。 */
function staleFixture({ sourceDir, indexFile, mutate }) {
  const dir = mkdtempSync(join(tmpdir(), "cm-index-"))
  cpSync(join(ROOT, sourceDir), join(dir, sourceDir), { recursive: true })
  cpSync(join(ROOT, indexFile), join(dir, indexFile))
  const sourceFile = readdirSync(join(dir, sourceDir)).filter((name) => name.endsWith(".json")).sort()[0]
  const target = join(dir, sourceDir, sourceFile)
  const doc = JSON.parse(readFileSync(target, "utf8"))
  mutate(doc)
  writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`)
  // 诊断按 id 报告（`<id>: sha256 mismatch …`），不是文件名。
  return { dir, sourceFile, id: doc.id }
}

function runBuilder(script, dir, envVar, ...args) {
  return spawnSync(process.execPath, [join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, [envVar]: dir },
  })
}

/** 合法的最小改动：patch 版本 +1（源契约要求 X.Y.Z，非法输入会走另一条失败分支）。 */
const bumpPatch = (doc) => {
  const [major, minor, patch] = doc.version.split(".").map(Number)
  doc.version = `${major}.${minor}.${patch + 1}`
}

const CASES = [
  {
    script: "build-registry.mjs",
    envVar: "BENCH_COMMAND_MARKET_DIR",
    sourceDir: "commands",
    indexFile: "registry.json",
    mutate: bumpPatch,
    label: "command",
  },
  {
    script: "build-rules.mjs",
    envVar: "BENCH_RULES_MARKET_DIR",
    sourceDir: "rules",
    indexFile: "rules.json",
    mutate: bumpPatch,
    label: "rule",
  },
]

describe("D07.1 源改动未重算索引（stale）必须失败并可修复", () => {
  for (const testCase of CASES) {
    it(`${testCase.label}：--check 失败并给出重算命令，重算后通过`, () => {
      const before = readFileSync(join(ROOT, testCase.indexFile), "utf8")
      const { dir, id } = staleFixture(testCase)
      try {
        const stale = runBuilder(testCase.script, dir, testCase.envVar, "--check")
        assert.equal(stale.status, 1, `stale 索引必须失败：\n${stale.stdout}${stale.stderr}`)
        assert.match(stale.stderr, /is out of date/)
        assert.match(stale.stderr, new RegExp(`hint: run \`node scripts/${testCase.script.replace(".", "\\.")}\``))
        assert.match(stale.stderr, new RegExp(`- ${id}: sha256 mismatch`), "诊断必须指向改了源的那个条目")

        // 按 hint 重算 → 同目录的 --check 必须通过（提示是可操作的）。
        const rebuild = runBuilder(testCase.script, dir, testCase.envVar)
        assert.equal(rebuild.status, 0, `${rebuild.stdout}${rebuild.stderr}`)
        const fresh = runBuilder(testCase.script, dir, testCase.envVar, "--check")
        assert.equal(fresh.status, 0, `${fresh.stdout}${fresh.stderr}`)
        assert.match(fresh.stdout, /up to date/)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
      assert.equal(readFileSync(join(ROOT, testCase.indexFile), "utf8"), before, "真实仓库索引不得被测试改动")
    })
  }

  it("真实仓库当前是 fresh（否则模型的前提就不成立）", () => {
    for (const testCase of CASES) {
      const result = runBuilder(testCase.script, ROOT, testCase.envVar, "--check")
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
    }
  })
})
