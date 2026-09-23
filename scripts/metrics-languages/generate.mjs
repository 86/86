import {readFile, writeFile} from "node:fs/promises"
import {createRequire} from "node:module"
import {dirname, join} from "node:path"
import yaml from "js-yaml"

const token = process.env.GH_PAT
const user = process.env.METRICS_USER
const output = process.env.METRICS_OUTPUT || "languages.svg"
const days = Number(process.env.METRICS_DAYS || 14)

if (!token || !user)
  throw new Error("GH_PAT and METRICS_USER are required")
if (!Number.isInteger(days) || days < 1)
  throw new Error("METRICS_DAYS must be a positive integer")

const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
const apiRoot = "https://api.github.com"
const maxRecentCommits = 300
const missingColor = "#8b949e"
const recentY = 50
const mostY = 174
const barOffset = 14
const labelOffset = 38

async function languageColors() {
  const require = createRequire(import.meta.url)
  const metadataPath = join(dirname(require.resolve("linguist-js/package.json")), "ext", "languages.yml")
  const metadata = yaml.load(await readFile(metadataPath, "utf8"))
  return new Map(Object.entries(metadata)
    .filter(([, details]) => /^#[0-9a-fA-F]{6}$/.test(details?.color || ""))
    .map(([language, details]) => [language, details.color]))
}

async function api(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(new URL(url, apiRoot), {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "profile-language-metrics",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    })
    if (response.ok)
      return {data: await response.json(), link: response.headers.get("link")}
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining")
      const reset = Number(response.headers.get("x-ratelimit-reset"))
      const retryAfter = response.headers.get("retry-after")
      const hint = remaining === "0" && reset > 0
        ? `; rate limit resets at ${new Date(reset * 1000).toISOString()}`
        : retryAfter ? `; retry after ${retryAfter}` : ""
      throw new Error(`GitHub API returned HTTP ${response.status}${hint}`)
    }
    if (![502, 503, 504].includes(response.status) || attempt === 2)
      throw new Error(`GitHub API returned HTTP ${response.status}`)
    const retryAfter = Number(response.headers.get("retry-after"))
    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 2000 * (attempt + 1)
    await new Promise(resolve => setTimeout(resolve, delay))
  }
}

function nextLink(link) {
  return link?.split(",").find(part => /rel="next"/.test(part))?.match(/<([^>]+)>/)?.[1]
}

async function pages(url) {
  const items = []
  while (url) {
    const response = await api(url)
    if (!Array.isArray(response.data))
      throw new Error("Unexpected GitHub API response")
    items.push(...response.data)
    url = nextLink(response.link)
  }
  return items
}

async function mapLimited(items, limit, callback) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await callback(items[index])
    }
  }))
  return results
}

async function recentCommits() {
  const query = `author:${user} author-date:>=${cutoff.toISOString().slice(0, 10)}`
  const commits = []
  let reportedTotal = 0
  let incomplete = false
  for (let page = 1; ; page++) {
    const params = new URLSearchParams({q: query, sort: "author-date", order: "desc", per_page: "100", page: String(page)})
    const {data} = await api(`/search/commits?${params}`)
    reportedTotal = Math.max(reportedTotal, data.total_count)
    incomplete ||= data.incomplete_results
    const inWindow = data.items.filter(commit => new Date(commit.commit.author.date) >= cutoff)
    const nonMerges = inWindow.filter(commit => commit.parents.length <= 1)
    commits.push(...nonMerges.slice(0, maxRecentCommits - commits.length))
    if (commits.length >= maxRecentCommits || !data.items.length || inWindow.length < data.items.length || page * 100 >= Math.min(data.total_count, 1000))
      break
  }
  const truncated = commits.length === maxRecentCommits && reportedTotal > maxRecentCommits
  if (truncated)
    console.warn(`Commit search matched ${reportedTotal} results; using the newest ${maxRecentCommits} commits`)
  if (incomplete)
    console.warn("GitHub reported incomplete commit search results; language metrics use the results returned")
  return {commits, partial: truncated || incomplete}
}

async function commitFiles(commit) {
  const repo = commit.repository.full_name
  const sha = commit.sha
  let url = `/repos/${repo}/commits/${sha}?per_page=100`
  const files = []
  while (url) {
    const response = await api(url)
    files.push(...response.data.files)
    url = nextLink(response.link)
  }
  return {repo, sha, files}
}

async function mostUsedLanguages() {
  const repos = (await pages("/user/repos?affiliation=owner&per_page=100"))
    .filter(repo => repo.owner.login.toLowerCase() === user.toLowerCase() && !repo.fork)
  const stats = await mapLimited(repos, 4, async repo => {
    const {data} = await api(`/repos/${repo.full_name}/languages`)
    return data
  })
  const totals = new Map()
  for (const languages of stats) {
    for (const [language, bytes] of Object.entries(languages))
      totals.set(language, (totals.get(language) || 0) + bytes)
  }
  return {totals, repositories: repos.length}
}

function patchContent(patch) {
  return (patch || "").split("\n")
    .filter(line => /^[ +\-]/.test(line) && !line.startsWith("+++ ") && !line.startsWith("--- "))
    .map(line => line.slice(1))
    .join("\n")
}

async function recentlyUsedLanguages() {
  const {commits, partial} = await recentCommits()
  console.log(`Found ${commits.length} commits in the last ${days} days`)
  const details = await mapLimited(commits, 4, commitFiles)
  const samplePaths = []
  const sampleContent = []
  const changes = new Map()
  let editedFiles = 0
  for (const {repo, sha, files} of details) {
    for (const file of files) {
      const weight = Number(file.additions || 0) + Number(file.deletions || 0)
      if (!weight)
        continue
      const key = `${repo}/${sha}/${file.filename}`
      samplePaths.push(key)
      sampleContent.push(patchContent(file.patch))
      changes.set(key, weight)
      editedFiles++
    }
  }

  const totals = new Map()
  if (samplePaths.length) {
    const {default: linguist} = await import("linguist-js")
    const result = await linguist(samplePaths, {fileContent: sampleContent, categories: ["programming", "markup"], offline: true})
    for (const [path, language] of Object.entries(result.files.results)) {
      if (!language || !changes.has(path))
        continue
      totals.set(language, (totals.get(language) || 0) + changes.get(path))
    }
  }
  return {totals, commits: commits.length, files: editedFiles, partial}
}

const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

function rows(totals) {
  const sorted = [...totals].filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1])
  const top = sorted.slice(0, 7)
  const other = sorted.slice(7).reduce((sum, [, value]) => sum + value, 0)
  if (other)
    top.push(["Other", other])
  return top
}

function section(title, subtitle, totals, colors, topY, id) {
  const entries = rows(totals)
  const sum = [...totals.values()].reduce((a, b) => a + b, 0)
  const barY = topY + barOffset
  let offset = 10
  const bar = entries.map(([language, value]) => {
    const width = 460 * value / sum
    const color = colors.get(language) || missingColor
    const rect = `<rect x="${offset.toFixed(2)}" y="${barY}" width="${width.toFixed(2)}" height="8" fill="${color}"/>`
    offset += width
    return rect
  }).join("")
  const labels = entries.map(([language, value], i) => {
    const column = Math.floor(i / 4)
    const x = 20 + column * 230
    const y = topY + labelOffset + (i % 4) * 19
    const color = colors.get(language) || missingColor
    return `<circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${color}"/><text class="label" x="${x + 16}" y="${y}">${xml(language)}</text><text class="percent" x="${x + 210}" y="${y}" text-anchor="end">${(100 * value / sum).toFixed(1)}%</text>`
  }).join("")
  return `<text class="heading" x="10" y="${topY}">${xml(title)}</text><text class="meta" x="470" y="${topY}" text-anchor="end">${xml(subtitle)}</text><rect x="10" y="${barY}" width="460" height="8" rx="4" fill="#d1d5da"/><g clip-path="url(#${id})">${bar}</g>${labels || `<text class="meta" x="10" y="${topY + labelOffset}">No language changes found</text>`}`
}

function renderSvg(recent, most, colors) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="302" viewBox="0 0 480 302" role="img" aria-label="GitHub language activity">
<defs><clipPath id="recent-bar"><rect x="10" y="${recentY + barOffset}" width="460" height="8" rx="4"/></clipPath><clipPath id="most-bar"><rect x="10" y="${mostY + barOffset}" width="460" height="8" rx="4"/></clipPath></defs>
<style>svg{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;color:#24292f}text{fill:#24292f}.title{font-size:17px;font-weight:400}.title,.heading{fill:#24292f}.heading{font-size:14px}.meta{font-size:11px;fill:#57606a}.label,.percent{font-size:12px}@media(prefers-color-scheme:dark){text{fill:#c9d1d9}.title,.heading{fill:#fff}.meta{fill:#8b949e}}</style>
<text class="title" x="10" y="22">Languages</text>
${section("Recently used languages", `${recent.commits} ${recent.partial ? "sampled " : ""}commits · ${days} days`, recent.totals, colors, recentY, "recent-bar")}
${section("Most used languages", `${most.repositories} repositories`, most.totals, colors, mostY, "most-bar")}
</svg>\n`
}

const [recent, most, colors] = await Promise.all([recentlyUsedLanguages(), mostUsedLanguages(), languageColors()])
await writeFile(output, renderSvg(recent, most, colors))
console.log(`Wrote ${output} from ${recent.files} edited files and ${most.repositories} repositories`)
