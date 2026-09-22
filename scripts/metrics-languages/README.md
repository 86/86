# Language metrics

The daily `metrics-languages` job writes `languages.svg` with two sections:

- **Recently used languages:** Search commits authored by `86` in the last 14 days. GitHub commit search returns commits on repository default branches. Skip merge commits to avoid counting their changes twice. For each remaining commit, fetch its changed files, classify the changed text and filename with the bundled LinguistJS data, and weight each language by additions plus deletions. Commits authored earlier than the window are excluded even if merged recently.
- **Most used languages:** Sum GitHub's language byte counts across owned, non-fork repositories.

Both sections use language colors from the bundled LinguistJS metadata. Languages without a defined color use a neutral gray.

The job reads the `GH_PAT` repository secret to include private repositories. A classic PAT needs the `repo` scope. The job samples at most the newest 300 commits and warns when the search is truncated or GitHub reports incomplete results.
Rate-limit responses stop the job without retrying; the error includes GitHub's reset time or retry hint when provided.

CI uses the official `pnpm/setup` action to install the pinned pnpm version, Node 24, and dependencies from the lockfile.
Pull requests targeting `main` run the tests in a separate workflow; daily SVG generation does not run them.
Run `node scripts/metrics-preview.mjs` from the repository root to create local mock SVGs in `preview/metrics/` for visual review.

To run the local test:

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test test.mjs
```

The project pins pnpm 11 and LinguistJS versions, requires Node 24, commits the integrity-checked lockfile, blocks install scripts and exotic subdependencies, and requires dependency releases to be at least seven days old when resolving updates. LinguistJS runs offline so it does not fetch classifier data at generation time.
