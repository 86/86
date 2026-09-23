# Base profile metrics

`generate.mjs` creates `github-metrics.svg` using GitHub GraphQL. It shows the account join year, followers, a small recent activity calendar, all-time commit, pull request, and review contributions, owned repository count, and starred repository count. GitHub contribution counts follow GitHub's profile contribution rules; they do not count every commit object in every branch.

The public `history.json` stores **aggregate totals only** for completed years. On the first run, the script queries each completed year. Later runs query only the current year. When a new year starts, it adds the newly completed year to the cache. Use the workflow's **Recalculate all completed years** manual-run option to refresh the cache if historical contributions or token access change. Locally, set `METRICS_REBUILD_HISTORY=1` for one run.

The workflow reads the `GH_PAT` repository secret to include private contributions. The token must belong to the profile owner and have access to the repositories being counted. A classic PAT needs `repo` and `read:user` scopes. If GitHub reports contributions the token cannot access, their types are excluded from the displayed totals and their aggregate count is recorded as `unavailableContributions` in the public `history.json`. The SVG and history contain aggregate counts only.

Run `node --test test.mjs` to check first-run, steady-state, and year-rollover behavior using mocked API responses.
After installing the language dependencies, run `node scripts/metrics-preview.mjs` from the repository root to render both SVGs with representative mock data in `preview/metrics/`. This preview uses no GitHub token or network requests.
