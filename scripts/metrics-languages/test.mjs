import assert from "node:assert/strict"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"

test("classifies recent default-branch changes and keeps repository totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "metrics-languages-"))
  const output = join(directory, "languages.svg")
  const recentDate = new Date(Date.now() - 2 * 86400000).toISOString()
  const oldDate = new Date(Date.now() - 20 * 86400000).toISOString()
  const calls = []
  const originalFetch = globalThis.fetch
  const originalEnv = {
    GH_PAT: process.env.GH_PAT,
    METRICS_USER: process.env.METRICS_USER,
    METRICS_DAYS: process.env.METRICS_DAYS,
    METRICS_OUTPUT: process.env.METRICS_OUTPUT,
  }
  process.env.GH_PAT = "test-token"
  process.env.METRICS_USER = "86"
  process.env.METRICS_DAYS = "14"
  process.env.METRICS_OUTPUT = output
  globalThis.fetch = async url => {
    const path = new URL(url).pathname
    calls.push(path)
    const data = path === "/search/commits"
      ? {total_count: 3, incomplete_results: false, items: [
        {sha: "recent", parents: [{sha: "previous"}], repository: {full_name: "86/example"}, commit: {author: {date: recentDate}}},
        {sha: "merge", parents: [{sha: "first"}, {sha: "second"}], repository: {full_name: "86/example"}, commit: {author: {date: recentDate}}},
        {sha: "old", parents: [{sha: "previous"}], repository: {full_name: "86/example"}, commit: {author: {date: oldDate}}},
      ]}
      : path === "/repos/86/example/commits/recent"
        ? {files: [
          {filename: "src/example.ts", additions: 3, deletions: 1, patch: "@@ -1 +1,3 @@\n-old\n+const x: number = 1\n+const y: number = 2"},
          {filename: "README.md", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+# Docs"},
        ]}
        : path === "/user/repos"
          ? [{full_name: "86/example", owner: {login: "86"}, fork: false}]
          : path === "/repos/86/example/languages"
            ? {Ruby: 300, Python: 100}
            : assert.fail(`Unexpected request: ${path}`)
    return new Response(JSON.stringify(data), {status: 200, headers: {"content-type": "application/json"}})
  }

  try {
    await import("./generate.mjs")
    const svg = await readFile(output, "utf8")
    assert.match(svg, /Recently used languages/)
    assert.match(svg, /Most used languages/)
    assert.match(svg, /TypeScript/)
    assert.match(svg, /Ruby/)
    assert.match(svg, /fill="#701516"/)
    assert.match(svg, /Python/)
    assert.match(svg, /75\.0%/)
    assert.match(svg, /25\.0%/)
    assert.match(svg, /1 commits · 14 days/)
    assert.ok(!calls.includes("/repos/86/example/commits/merge"))
    assert.ok(!calls.includes("/repos/86/example/commits/old"))
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
    await rm(directory, {recursive: true, force: true})
  }
})
