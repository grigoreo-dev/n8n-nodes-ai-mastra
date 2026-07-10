# GitHub Actions CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub Actions CI workflow that runs typecheck, tests, and build in parallel on every push to `main` and every pull request, on a coherent pinned Node version.

**Architecture:** One workflow file with three independent parallel jobs (checkout → setup-node → `npm ci` → run one npm script each), plus a small version alignment (`.nvmrc`, `engines`, tsup target) so CI runs the same Node the project actually targets.

**Tech Stack:** GitHub Actions (`actions/checkout@v4`, `actions/setup-node@v4`), npm, tsup, vitest, TypeScript.

## Global Constraints

- Repo content is English only (code, comments, docs, identifiers, log/error strings, commit messages). Chat may be Russian.
- No new runtime dependencies.
- CI jobs use `npm ci` (not `npm install`); `package-lock.json` is present and tracked.
- Node is pinned via `.nvmrc` containing `24`; jobs use `actions/setup-node@v4` with `node-version-file: .nvmrc` and `cache: npm`.
- `engines.node` must be `>=22.22`; tsup `target` must be `node22`.
- The three CI jobs run these exact scripts: `npm run typecheck`, `npm run test`, `npm run build`.
- After version changes, `npm run typecheck`, `npm run test`, and `npm run build` must all stay green.

---

## File Structure

- `.nvmrc` (create): single line `24` — pins Node for dev and CI.
- `package.json` (modify): `engines.node` → `>=22.22`.
- `tsup.config.ts` (modify): `target` → `node22`.
- `.github/workflows/ci.yml` (create): the CI workflow with three jobs.

---

## Task 1: Version alignment

**Files:**
- Create: `.nvmrc`
- Modify: `package.json` (the `engines` field)
- Modify: `tsup.config.ts:35` (the `target` line)

**Interfaces:**
- Consumes: nothing.
- Produces: a repo pinned to Node 24 (`.nvmrc`) with `engines.node` `>=22.22` and tsup `target: 'node22'`. Task 2's `setup-node` reads `.nvmrc`.

- [ ] **Step 1: Create `.nvmrc`**

Create `.nvmrc` with exactly this content (single line, trailing newline):

```
24
```

- [ ] **Step 2: Raise the Node engines floor**

In `package.json`, change the `engines` field from:

```json
  "engines": {
    "node": ">=20.15"
  },
```

to:

```json
  "engines": {
    "node": ">=22.22"
  },
```

(`package.json` uses 2-space indentation — keep it. Do not reformat anything else.)

- [ ] **Step 3: Bump the tsup target**

In `tsup.config.ts`, change line 35 from:

```typescript
	target: 'node20',
```

to:

```typescript
	target: 'node22',
```

- [ ] **Step 4: Verify the project still builds and passes**

Run: `npm run typecheck && npm run test && npm run build`
Expected: typecheck exits 0 (no output), vitest reports all tests passing (currently 46), and tsup prints `Build success`. No errors.

- [ ] **Step 5: Commit**

```bash
git add .nvmrc package.json tsup.config.ts
git commit -m "build: pin Node 24 and align engines/tsup target with n8n 2.29 (>=22.22)"
```

---

## Task 2: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `.nvmrc` (Task 1); the npm scripts `typecheck`, `test`, `build` (already in `package.json`).
- Produces: a CI workflow that runs on push-to-main and PRs.

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/ci.yml` with exactly this content:

```yaml
name: CI

on:
  pull_request:
  push:
    branches:
      - main

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  typecheck:
    name: typecheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Typecheck
        run: npm run typecheck

  test:
    name: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Run unit tests
        run: npm run test

  build:
    name: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Build
        run: npm run build
```

- [ ] **Step 2: Validate the workflow YAML parses**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/ci.yml','utf8');if(!/^name: CI$/m.test(s))throw new Error('missing name');if(!/jobs:/.test(s))throw new Error('missing jobs');console.log('yaml basic checks ok')"`
Expected: prints `yaml basic checks ok` (basic sanity — full validation happens when GitHub runs it).

- [ ] **Step 3: Prove CI will pass by running the same commands on a clean install**

Run: `npm ci && npm run typecheck && npm run test && npm run build`
Expected: `npm ci` installs from the lockfile without error; typecheck exits 0; vitest reports all tests passing; tsup prints `Build success`. This mirrors exactly what the three CI jobs do.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for typecheck, test, and build"
```

---

## Self-Review

- **Spec coverage:** workflow with 3 parallel jobs on push-to-main + PR, concurrency cancellation, npm cache, `npm ci` (Task 2); `.nvmrc`=24, `engines.node`>=22.22, tsup target node22 (Task 1); verification that the trio stays green (Task 1 Step 4 + Task 2 Step 3). Out-of-scope items (E2E, lint job, publish) are not tasked — correct. The `test`-needs-no-Postgres fact is implicitly honored: the `test` job runs `npm run test` with no service container.
- **Placeholder scan:** every step has exact content/commands; no TBD/TODO/vague steps.
- **Type consistency:** the npm script names (`typecheck`, `test`, `build`) match `package.json` exactly; `.nvmrc` filename referenced consistently in Task 1 and Task 2's `node-version-file`.
