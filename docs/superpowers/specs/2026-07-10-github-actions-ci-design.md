# GitHub Actions CI Design

## Goal

On every push to `main` and every pull request, automatically verify the project
is not broken: types compile, unit tests pass, and the bundle builds. Modeled on
the padloc repo's `ci.yml` (parallel jobs, concurrency cancellation, dependency
cache), adapted to this project's npm + tsup + vitest stack.

## Scope

In scope:

- A single workflow `.github/workflows/ci.yml` with three parallel jobs:
  `typecheck`, `test`, `build`.
- Concurrency group with `cancel-in-progress` so a newer push cancels an
  in-flight run for the same ref/PR.
- Version alignment (a small, targeted fix surfaced while designing this):
  add `.nvmrc`, raise `engines.node`, and bump the tsup `target`.

Out of scope:

- End-to-end tests inside a real n8n (tracked separately as a backlog research
  item).
- A dedicated lint job — this project's `lint` script is `tsc --noEmit`, already
  covered by the `typecheck` job.
- Publish / release automation.

## Background

This project differs from padloc: it uses npm (not pnpm), tsup bundling (not
PWA/electron), vitest for unit tests, and has no real linter or E2E suite. So the
CI mirrors padloc's *shape* (parallel jobs, checkout → setup-node → install →
run, concurrency) rather than copying its jobs verbatim.

Established facts the design relies on:

- The full test suite (46 tests) passes with **no Postgres available** — verified
  by stopping the dev Postgres container and re-running `vitest`. The `test` job
  therefore needs no service container, secrets, or network.
- `package-lock.json` is present and tracked in git, so `npm ci` works in CI.
- The dev environment already runs Node 24; n8n 2.29 requires `node >=22.22`,
  while the repo's `engines` (`>=20.15`) and tsup `target` (`node20`) are stale
  and understate the real requirement.

## CI workflow

`.github/workflows/ci.yml`:

- Triggers: `pull_request` and `push` to `main`.
- `concurrency`: group
  `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`,
  `cancel-in-progress: true`.
- Three jobs, all `runs-on: ubuntu-latest`, each independent and parallel:
  - `typecheck`: checkout → setup-node → `npm ci` → `npm run typecheck`.
  - `test`: checkout → setup-node → `npm ci` → `npm run test`.
  - `build`: checkout → setup-node → `npm ci` → `npm run build`.
- Every job's setup step:
  - `actions/checkout@v4`
  - `actions/setup-node@v4` with `node-version-file: .nvmrc` and `cache: npm`.

Rationale:

- `npm ci` (not `npm install`) installs reproducibly from `package-lock.json`.
- `cache: npm` reuses the dependency cache across runs.
- Each job installs independently for isolation, matching padloc's structure.
  Three parallel `npm ci` runs are acceptable at this project's size.
- The `build` job pulls in the heavy Mastra dependency tree, which is exactly
  what we want CI to exercise.

## Version alignment

Targeted fixes to remove the stale-version mismatch, done alongside the CI so CI
runs on a coherent version:

- Create `.nvmrc` containing `24` — pins the dev/CI Node version and feeds
  `setup-node`'s `node-version-file`.
- `package.json`: `engines.node` `>=20.15` → `>=22.22` (reflects n8n 2.29's
  requirement).
- `tsup.config.ts`: `target` `node20` → `node22` (kept in sync with `engines`).

Verification: after the change, `npm run typecheck`, `npm run test`, and
`npm run build` must all stay green (bumping the tsup target to node22 must not
break the build; the dev machine already runs node 24).

## Error handling and edge cases

- Any failing job produces a red check on the PR/commit (standard GitHub
  Actions behavior); nothing special to configure.
- `concurrency` cancels superseded runs on rapid pushes.
- No secrets, no external-API network calls, and no database — nothing to make
  the runs flaky.

## Testing the CI

CI cannot be fully exercised locally, so:

- Validate the workflow YAML syntax locally.
- Before merging, run the same commands on a clean checkout
  (`npm ci && npm run typecheck && npm run test && npm run build`) to prove CI
  will pass.
- The real confirmation is the first push/PR showing green checks.

## Acceptance

- `.github/workflows/ci.yml` exists with `typecheck`, `test`, and `build` jobs
  running in parallel on push-to-main and PRs, with concurrency cancellation and
  npm caching.
- `.nvmrc` pins Node 24; `engines.node` is `>=22.22`; tsup `target` is `node22`.
- `npm ci && npm run typecheck && npm run test && npm run build` succeeds on a
  clean checkout, and the first CI run reports green.
