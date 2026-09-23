import {mkdir, writeFile} from "node:fs/promises"
import {resolve} from "node:path"
import {fileURLToPath} from "node:url"
import {renderSvg} from "./metrics-base/generate.mjs"

const defaultDirectory = fileURLToPath(new URL("../preview/metrics/", import.meta.url))
const directory = resolve(process.argv[2] || defaultDirectory)
const baseOutput = resolve(directory, "github-metrics.svg")
const languagesOutput = resolve(directory, "languages.svg")
const now = new Date()
const day = 24 * 60 * 60 * 1000

await mkdir(directory, {recursive: true})

const profile = {
  createdAt: "2011-03-01T00:00:00Z",
  followers: {totalCount: 61},
  repositories: {totalCount: 99},
  starredRepositories: {totalCount: 2214},
}
const totals = {commits: 15073, pullRequests: 800, reviews: 237}
const contributions = [0, 2, 3, 1, 0, 5, 7, 2, 4, 0, 1, 6, 3, 2]
const days = contributions.map((contributionCount, index) => ({
  date: new Date(now.getTime() - (13 - index) * day).toISOString().slice(0, 10),
  contributionCount,
}))
await writeFile(baseOutput, renderSvg("86", profile, totals, days, now))

const files = [
  ["App.swift", 120, 20, "-old\n+let greeting = \"hello\""],
  ["src/app.ts", 55, 15, "-old\n+const greeting: string = \"hello\""],
  ["src/lib.rs", 35, 10, "-old\n+fn main() {}"],
  ["main.py", 22, 8, "-old\n+def greet(): pass"],
  ["app.rb", 12, 4, "-old\n+puts \"hello\""],
  ["index.html", 10, 2, "-old\n+<main>Hello</main>"],
].map(([filename, additions, deletions, patch]) => ({filename, additions, deletions, patch}))

const responses = new Map([
  ["/repos/86/example/commits/preview", {files}],
  ["/user/repos", [
    {full_name: "86/example", owner: {login: "86"}, fork: false},
    {full_name: "86/another", owner: {login: "86"}, fork: false},
  ]],
  ["/repos/86/example/languages", {Swift: 45000, TypeScript: 20000, Rust: 8000, Python: 6000, Ruby: 2000}],
  ["/repos/86/another/languages", {Swift: 9000, TypeScript: 5000, JavaScript: 3000, C: 2000}],
])
const originalFetch = globalThis.fetch
const originalEnv = Object.fromEntries(["GH_PAT", "METRICS_USER", "METRICS_DAYS", "METRICS_OUTPUT"].map(key => [key, process.env[key]]))
try {
  process.env.GH_PAT = "preview-token"
  process.env.METRICS_USER = "86"
  process.env.METRICS_DAYS = "14"
  process.env.METRICS_OUTPUT = languagesOutput
  globalThis.fetch = async url => {
    const path = new URL(url).pathname
    const data = path === "/search/commits"
      ? {total_count: 1, incomplete_results: false, items: [{
        sha: "preview",
        parents: [{sha: "previous"}],
        repository: {full_name: "86/example"},
        commit: {author: {date: new Date(now.getTime() - 2 * day).toISOString()}},
      }]}
      : responses.get(path)
    if (data === undefined)
      throw new Error(`Unexpected preview API request: ${path}`)
    return Response.json(data)
  }
  await import("./metrics-languages/generate.mjs")
} finally {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined)
      delete process.env[key]
    else
      process.env[key] = value
  }
}

console.log(`Mock preview SVGs: ${baseOutput}, ${languagesOutput}`)
