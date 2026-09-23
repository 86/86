import {readFile, writeFile} from "node:fs/promises"
import {pathToFileURL} from "node:url"

const apiUrl = "https://api.github.com/graphql"
const metricKeys = ["commits", "pullRequests", "reviews", "unavailableContributions"]
const contributionLevels = {NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4}
const emptyTotals = () => ({commits: 0, pullRequests: 0, reviews: 0, unavailableContributions: 0})
const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const profileQuery = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  viewer { login }
  user(login: $login) {
    createdAt
    followers(first: 1) { totalCount }
    repositories(first: 1, ownerAffiliations: OWNER) { totalCount }
    starredRepositories(first: 1) { totalCount }
    calendar: contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks { contributionDays { date contributionCount contributionLevel } }
      }
    }
  }
}`

const annualQuery = `query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
    }
  }
}`

async function graphql(token, query, variables, fetcher) {
  const response = await fetcher(apiUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-base-metrics",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({query, variables}),
  })
  if (!response.ok)
    throw new Error(`GitHub GraphQL returned HTTP ${response.status}`)
  const result = await response.json()
  if (result.errors?.length)
    throw new Error(`GitHub GraphQL: ${result.errors.map(error => error.message).join("; ")}`)
  if (!result.data?.user)
    throw new Error(`GitHub user ${variables.login} was not found`)
  if (query === profileQuery) {
    const viewer = result.data.viewer?.login
    if (viewer?.toLowerCase() !== variables.login.toLowerCase())
      throw new Error(`GH_PAT belongs to ${viewer ?? "an unknown user"}, expected ${variables.login}`)
    console.log(`Authenticated GitHub user: ${viewer}`)
  }
  return result.data.user
}

function annualRange(year) {
  return {
    from: new Date(Date.UTC(year, 0, 1)).toISOString(),
    to: new Date(Date.UTC(year + 1, 0, 1) - 1).toISOString(),
  }
}

function readTotals(collection, year) {
  const totals = {
    commits: collection?.totalCommitContributions,
    pullRequests: collection?.totalPullRequestContributions,
    reviews: collection?.totalPullRequestReviewContributions,
    unavailableContributions: collection?.restrictedContributionsCount,
  }
  if (metricKeys.some(key => !Number.isSafeInteger(totals[key]) || totals[key] < 0))
    throw new Error("Invalid contribution totals from GitHub")
  if (totals.unavailableContributions)
    console.warn(`GitHub reports ${totals.unavailableContributions} inaccessible contributions in ${year}; their types cannot be included in the activity totals`)
  return totals
}

function addTotals(left, right) {
  return Object.fromEntries(metricKeys.map(key => [key, left[key] + right[key]]))
}

async function loadHistory(path, user, currentYear, firstYear) {
  let history
  try {
    history = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT")
      return {user, throughYear: firstYear - 1, totals: emptyTotals()}
    throw error
  }
  if (history.user !== user || !Number.isInteger(history.throughYear) || history.throughYear < firstYear - 1 || history.throughYear >= currentYear ||
      metricKeys.some(key => !Number.isSafeInteger(history.totals?.[key]) || history.totals[key] < 0))
    throw new Error("Invalid metrics history; rebuild it with METRICS_REBUILD_HISTORY=1")
  return history
}

function calendarDays(profile) {
  const days = profile.calendar?.contributionCalendar?.weeks?.flatMap(week => week.contributionDays) || []
  return days.filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isSafeInteger(day.contributionCount) && Object.hasOwn(contributionLevels, day.contributionLevel)).slice(-14)
}

export function renderSvg(user, profile, totals, days, now) {
  const name = xml(user)
  const joinedYear = new Date(profile.createdAt).getUTCFullYear()
  const cells = days.map((day, index) => {
    const level = contributionLevels[day.contributionLevel]
    return `<rect class="day level-${level}" x="${260 + index * 15}" y="36" width="11" height="11" rx="2"><title>${xml(day.date)}: ${day.contributionCount} contributions</title></rect>`
  }).join("")
  const updated = now.toISOString().slice(0, 10)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="211" viewBox="0 0 480 211" role="img" aria-label="GitHub profile metrics for ${name}">
<style>svg{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}text{fill:#57606a}.title,.heading{fill:#24292f}.title{font-size:25px;font-weight:600}.heading{font-size:15px}.label{font-size:13px}.value{font-size:13px;font-weight:600;fill:#24292f}.meta{font-size:11px}.day{fill:#eff2f5}.level-1{fill:#aceebb}.level-2{fill:#4ac26b}.level-3{fill:#2da44e}.level-4{fill:#116329}@media(prefers-color-scheme:dark){text{fill:#8b949e}.title,.heading{fill:#fff}.value{fill:#c9d1d9}.day{fill:#151b23}.level-1{fill:#033a16}.level-2{fill:#196c2e}.level-3{fill:#2ea043}.level-4{fill:#56d364}}</style>
<text class="title" x="10" y="31">${name}</text>
<text class="label" x="10" y="54">Joined GitHub in ${joinedYear}</text>
<text class="label" x="10" y="73">${profile.followers.totalCount} followers</text>
${cells}
<text class="meta" x="260" y="65">Activity over the last 14 days</text>
<text class="heading" x="10" y="105">Activity</text>
<text class="label" x="10" y="134">Commits</text><text class="value" x="220" y="134" text-anchor="end">${totals.commits.toLocaleString("en-US")}</text>
<text class="label" x="10" y="158">Pull requests</text><text class="value" x="220" y="158" text-anchor="end">${totals.pullRequests.toLocaleString("en-US")}</text>
<text class="label" x="10" y="182">Pull request reviews</text><text class="value" x="220" y="182" text-anchor="end">${totals.reviews.toLocaleString("en-US")}</text>
<text class="label" x="250" y="134">Repositories</text><text class="value" x="470" y="134" text-anchor="end">${profile.repositories.totalCount.toLocaleString("en-US")}</text>
<text class="label" x="250" y="158">Starred repositories</text><text class="value" x="470" y="158" text-anchor="end">${profile.starredRepositories.totalCount.toLocaleString("en-US")}</text>
<text class="meta" x="470" y="203" text-anchor="end">Updated ${updated}</text>
</svg>\n`
}

export async function generate({
  token = process.env.GH_PAT,
  user = process.env.METRICS_USER,
  output = process.env.METRICS_OUTPUT || "github-metrics.svg",
  historyPath = process.env.METRICS_HISTORY || "scripts/metrics-base/history.json",
  rebuild = process.env.METRICS_REBUILD_HISTORY === "1",
  now = new Date(),
  fetcher = fetch,
} = {}) {
  if (!token || !user)
    throw new Error("GH_PAT and METRICS_USER are required")
  if (Number.isNaN(now.getTime()))
    throw new Error("Invalid current date")
  const currentYear = now.getUTCFullYear()
  const calendarFrom = new Date(now)
  calendarFrom.setUTCFullYear(now.getUTCFullYear() - 1)
  const profile = await graphql(token, profileQuery, {login: user, from: calendarFrom.toISOString(), to: now.toISOString()}, fetcher)
  const firstYear = new Date(profile.createdAt).getUTCFullYear()
  if (!Number.isInteger(firstYear) || firstYear > currentYear)
    throw new Error("Invalid account creation date from GitHub")

  let history = rebuild
    ? {user, throughYear: firstYear - 1, totals: emptyTotals()}
    : await loadHistory(historyPath, user, currentYear, firstYear)
  const yearly = async year => {
    const data = await graphql(token, annualQuery, {login: user, ...annualRange(year)}, fetcher)
    return readTotals(data.contributionsCollection, year)
  }
  let changed = rebuild
  for (let year = history.throughYear + 1; year < currentYear; year++) {
    history = {user, throughYear: year, totals: addTotals(history.totals, await yearly(year))}
    changed = true
  }
  const totals = addTotals(history.totals, await yearly(currentYear))
  if (totals.unavailableContributions)
    console.warn(`Across all years, GitHub reports ${totals.unavailableContributions} inaccessible contributions`)
  const svg = renderSvg(user, profile, totals, calendarDays(profile), now)
  await writeFile(output, svg)
  if (changed || !rebuild && history.throughYear === firstYear - 1) {
    await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`)
  }
  console.log(`Wrote ${output} with ${history.throughYear} as the last cached year`)
  return {totals, history}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await generate()
