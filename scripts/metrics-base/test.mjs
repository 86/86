import assert from "node:assert/strict"
import {mkdtemp, readFile, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import {join} from "node:path"
import test from "node:test"
import {generate} from "./generate.mjs"

test("caches completed years and refreshes the current year", async () => {
  const directory = await mkdtemp(join(tmpdir(), "metrics-base-"))
  const output = join(directory, "github-metrics.svg")
  const historyPath = join(directory, "history.json")
  const calls = []
  let restrictedYear = null
  let viewerLogin = "86"
  const fetcher = async (url, options) => {
    assert.equal(url, "https://api.github.com/graphql")
    assert.equal(options.headers.Authorization, "Bearer test-token")
    const {query, variables} = JSON.parse(options.body)
    if (query.includes("calendar:")) {
      return Response.json({data: {viewer: {login: viewerLogin}, user: {
        createdAt: "2024-07-01T00:00:00Z",
        followers: {totalCount: 61},
        repositories: {totalCount: 99},
        starredRepositories: {totalCount: 2214},
        calendar: {contributionCalendar: {weeks: [{contributionDays: [
          {date: "2026-09-22", contributionCount: 3},
          {date: "2026-09-23", contributionCount: 0},
        ]}]}},
      }}})
    }
    const year = Number(variables.from.slice(0, 4))
    calls.push(year)
    const contributions = {
      totalCommitContributions: year === 2024 ? 10 : year === 2025 ? 20 : year === 2026 ? 30 : 40,
      totalPullRequestContributions: year - 2023,
      totalPullRequestReviewContributions: (year - 2023) * 2,
      restrictedContributionsCount: year === restrictedYear ? 1 : 0,
    }
    return Response.json({data: {user: {contributionsCollection: contributions}}})
  }

  try {
    const options = {token: "test-token", user: "86", output, historyPath, fetcher}
    await generate({...options, now: new Date("2026-09-23T12:00:00Z")})
    assert.deepEqual(calls, [2024, 2025, 2026])
    assert.deepEqual(JSON.parse(await readFile(historyPath, "utf8")), {
      user: "86", throughYear: 2025, totals: {commits: 30, pullRequests: 3, reviews: 6, unavailableContributions: 0},
    })
    assert.match(await readFile(output, "utf8"), /<text class="value" x="220" y="134" text-anchor="end">60<\/text>/)

    calls.length = 0
    await generate({...options, now: new Date("2026-09-24T12:00:00Z")})
    assert.deepEqual(calls, [2026])

    calls.length = 0
    await generate({...options, now: new Date("2027-01-02T12:00:00Z")})
    assert.deepEqual(calls, [2026, 2027])
    assert.deepEqual(JSON.parse(await readFile(historyPath, "utf8")), {
      user: "86", throughYear: 2026, totals: {commits: 60, pullRequests: 6, reviews: 12, unavailableContributions: 0},
    })

    restrictedYear = 2027
    await generate({...options, now: new Date("2028-01-02T12:00:00Z")})
    assert.deepEqual(JSON.parse(await readFile(historyPath, "utf8")), {
      user: "86", throughYear: 2027, totals: {commits: 100, pullRequests: 10, reviews: 20, unavailableContributions: 1},
    })

    viewerLogin = "someone-else"
    calls.length = 0
    await assert.rejects(
      generate({...options, now: new Date("2028-01-02T12:00:00Z")}),
      /GH_PAT belongs to someone-else, expected 86/,
    )
    assert.deepEqual(calls, [])
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
})
