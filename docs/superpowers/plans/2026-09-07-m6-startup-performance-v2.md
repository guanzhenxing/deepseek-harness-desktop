# M6 Startup Performance and Observability V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure packaged daily startup by owned stage and deliver at most one evidence-selected optimisation while preserving every accepted release, home, lease, recovery, and navigation invariant.

**Architecture:** A smoke-only timeline collector in Electron Main marks existing ownership boundaries and emits path-free stage records. The packaged-DMG harness performs one initialization and ten isolated warm runs, then permits one optimisation only when a stable adjacent stage dominates.

**Tech Stack:** Node 24.11.1, pnpm 11.7.0, Electron 44.1.0, TypeScript, Vitest, Node test runner, existing `installFromDmg`/`runInstalledApp` harness. No dependency upgrade is in scope.

**Spec:** [Post-M4 delivery design](../specs/2026-09-07-post-m4-delivery-design.md)

## Global Constraints

- Resolve the baseline at execution start from the M5 accepted release ID and DMG SHA; never use historical `8997ef3`.
- Build and benchmark only macOS arm64 until another platform records its own baseline.
- Use one fresh temporary installation, home, and `userData`; never use a real home, Application Support directory, `/Applications`, or active instance.
- Normal launches emit no timing event, file, setting, analytics record, or network request.
- Keep the independent Host utility process, home admission, lease ownership/watchdog, Safe Mode, authenticated loopback surface, and official-UI predicate intact.
- Do not upgrade DSH, Electron, Node, pnpm, or any plugin while measuring or optimising.
- Initialization and warm trials are distinct populations and must never be averaged together.

---

### Task 1: Define a strict smoke-only timeline contract

**Files:**

- Create: `apps/desktop-launcher/src/startup-timeline.ts`
- Create: `apps/desktop-launcher/test/startup-timeline.test.ts`
- Modify: `apps/desktop-launcher/src/m0-paths.ts`
- Modify: `apps/desktop-launcher/test/m0-paths.test.ts`

**Interfaces:**

- Produces: `StartupStage`, `StartupTimelineEvent`, and `createStartupTimeline(enabled, emit)`.
- Consumes later: Electron Main instrumentation in Task 2.

- [ ] **Step 1: Write failing timeline tests**

Define the only allowed stages:

```ts
const STARTUP_STAGES = [
  'launcher-ready',
  'loading-visible',
  'home-admitted',
  'host-spawned',
  'host-ready',
  'surface-loaded',
  'official-ui-ready',
] as const
```

Test that enabled marks emit exactly `{ kind: 'startup-perf-stage', stage, elapsedMs }`, elapsed values are non-negative integers and nondecreasing, duplicate/reordered stages throw, and disabled mode emits nothing.

- [ ] **Step 2: Write failing smoke-admission tests**

Extend `m0-paths.test.ts`:

```ts
expect(await resolveSmokeUserData('startup-perf', root)).toBe(root)
await expect(resolveSmokeUserData('startup-perf', '/Users/shared')).rejects.toThrow(/temporary/u)
```

- [ ] **Step 3: Run the tests and observe failure**

Run:

```bash
corepack pnpm@11.7.0 vitest run apps/desktop-launcher/test/startup-timeline.test.ts apps/desktop-launcher/test/m0-paths.test.ts
```

Expected: FAIL because the contract and mode do not exist.

- [ ] **Step 4: Implement the contract**

Use `performance.now()` as the elapsed source so the value is monotonic and relative to process time origin. Freeze every event before emission. Reject any attempt to skip, repeat, reorder, or append a field through the typed API.

Add `startup-perf` to `SMOKE_MODES`; retain all existing absolute-path, temporary-parent, real-directory, and symlink checks.

- [ ] **Step 5: Run the focused tests**

Run the Task 1 Vitest command again.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop-launcher/src/startup-timeline.ts apps/desktop-launcher/src/m0-paths.ts apps/desktop-launcher/test/startup-timeline.test.ts apps/desktop-launcher/test/m0-paths.test.ts
git commit -m "feat: define smoke startup timeline"
```

### Task 2: Instrument existing launcher-owned boundaries

**Files:**

- Modify: `apps/desktop-launcher/src/main.ts`
- Modify: `packages/host-supervisor/test/supervisor.test.ts`
- Modify: `apps/desktop-launcher/test/startup-timeline.test.ts`

**Interfaces:**

- Consumes: `createStartupTimeline(smokeMode === 'startup-perf', smokeReport)`.
- Produces: seven events at existing boundaries without changing normal startup sequencing.

- [ ] **Step 1: Add a failing integration-style ordering test**

Drive the existing ports with deferred promises and assert no event appears before the owning fact resolves. In particular, hold `runHomeCompatibilityChain`, `HostSupervisor.start`, `loadSurface`, and `waitForOfficialUi` separately and verify the timeline stops at the preceding stage.

- [ ] **Step 2: Run the test and observe failure**

Run: `corepack pnpm@11.7.0 vitest run apps/desktop-launcher/test/startup-timeline.test.ts packages/host-supervisor/test/supervisor.test.ts`

Expected: FAIL because Main has not connected the marks.

- [ ] **Step 3: Add the seven marks**

Place marks only at these seams:

```ts
timeline.mark('launcher-ready') // app.whenReady resolved, before startApplication
timeline.mark('loading-visible') // showLoading resolved true and window is visible
timeline.mark('home-admitted') // runHomeCompatibilityChain resolved
timeline.mark('host-spawned') // HostSupervisor onEvent kind === 'starting'
timeline.mark('host-ready') // attemptSupervisor.start resolved
timeline.mark('surface-loaded') // port.loadSurface resolved
timeline.mark('official-ui-ready') // waitForOfficialUi resolved
```

Treat `startup-perf` like the existing loading smoke for loading-page display. Do not move calls, add waits, or emit surface URLs, paths, PIDs, capabilities, cookies, or profile data in timing events.

- [ ] **Step 4: Run normal-mode silence and ordering tests**

Run:

```bash
corepack pnpm@11.7.0 vitest run apps/desktop-launcher/test/startup-timeline.test.ts apps/desktop-launcher/test/m0-paths.test.ts packages/host-supervisor/test/supervisor.test.ts
corepack pnpm@11.7.0 smoke:dsh-ui
```

Expected: tests pass; normal/UI smoke behavior is unchanged; only `startup-perf` emits stage events.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-launcher/src/main.ts apps/desktop-launcher/test/startup-timeline.test.ts packages/host-supervisor/test/supervisor.test.ts
git commit -m "feat: instrument packaged startup boundaries"
```

### Task 3: Build the packaged benchmark and report validator

**Files:**

- Create: `tests/helpers/startup-performance.mjs`
- Create: `tests/helpers/startup-performance.test.mjs`
- Modify: `tests/smoke/package-main.mjs`
- Create: `tests/smoke/startup-performance.mjs`
- Modify: `package.json`
- Generated: `release/startup-performance.json`

**Interfaces:**

- Produces: `validateTimeline(events)`, `summarizeWarmRuns(runs)`, `validateStartupReport(report, artifact)`, and `runStartupPerformance()`.
- Consumes: installed DMG, `release/artifacts.json`, and seven stage events from Task 2.

- [ ] **Step 1: Write failing schema and statistics tests**

Test rejection for a missing stage, duplicate stage, decreasing elapsed value, extra event field, absolute path anywhere in JSON, fewer than ten warm trials, candidate mismatch, and surviving lease marker.

Define nearest-rank P95 exactly:

```js
export function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
}
```

For ten values, assert P95 is the largest observation; record that conservative behavior in the report schema test.

- [ ] **Step 2: Run the test and observe failure**

Run: `corepack pnpm@11.7.0 vitest run tests/helpers/startup-performance.test.mjs`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement validation and summaries**

Compute adjacent stage durations from cumulative events, plus warm total median and P95. Preserve every raw initialization and warm timeline. Reject non-finite values and identity disagreements.

The report schema is:

```js
{
  schemaVersion: 1,
  candidate: { releaseId, dmgSha256, sourceCommit },
  platform: { osRelease, arch, node, electron },
  initialization: { events, stages, totalMs },
  warm: { runs, totalMedianMs, totalP95Ms, stageMediansMs, stageP95Ms },
}
```

No timestamp or absolute path is required for identity and reproducibility; execution date and hardware model belong in the committed acceptance record.

- [ ] **Step 4: Implement the isolated DMG trials**

Use `installFromDmg` once. Create one temporary home and `userData`, run one initialization trial, then ten warm trials sequentially against the same initialized fixture. After every run require:

- launcher exit;
- Host and descendants absent;
- home lease absent;
- DMG mount and installation still owned by the harness;
- the next run does not begin until cleanup checks pass.

Write the validated report atomically to `release/startup-performance.json`.

- [ ] **Step 5: Add the command**

Add:

```json
"smoke:startup-performance": "node tests/smoke/startup-performance.mjs"
```

The command must refuse a missing/stale `release/artifacts.json` and must use the installed candidate, never workspace Electron.

- [ ] **Step 6: Run helper tests and one real report**

Run:

```bash
corepack pnpm@11.7.0 vitest run tests/helpers/startup-performance.test.mjs
corepack pnpm@11.7.0 package:dir
corepack pnpm@11.7.0 package:dmg
corepack pnpm@11.7.0 smoke:startup-performance
```

Expected: tests pass; the real report contains one initialization and ten complete warm timelines bound to the DMG SHA; cleanup passes.

- [ ] **Step 7: Commit**

```bash
git add tests/helpers/startup-performance.mjs tests/helpers/startup-performance.test.mjs tests/smoke/package-main.mjs tests/smoke/startup-performance.mjs package.json
git commit -m "feat: benchmark installed startup stages"
```

### Task 4: Review measurements and select zero or one optimisation

**Files:**

- Create initially: `docs/validation/m6-acceptance.md`
- Create only when optimisation is selected: `docs/superpowers/plans/2026-09-07-m6-selected-optimisation.md`
- Read generated: `release/startup-performance.json`

**Interfaces:**

- Consumes: ten warm timelines for one exact candidate.
- Produces: a measurement-only conclusion or one implementation plan naming the dominant adjacent stage, target, seam, and regressions.

- [ ] **Step 1: Record execution conditions and raw result digest**

Record candidate release ID/SHA/source commit, Mac model, CPU, memory, macOS, power mode, Node/Electron versions, report SHA, initialization total, every warm total, and every stage median/P95.

- [ ] **Step 2: Apply the stability rule**

Treat a stage as stable only when its warm median is positive and its P95 is no more than twice its median. Treat a stage as dominant only when its median is at least 35% of warm total median and at least 1.25 times the next-largest stage median.

- [ ] **Step 3: Stop cleanly when no stable dominant stage exists**

If the rule selects none, mark M6 `measurement-only`; record the noisy/flat result and do not edit production startup behavior.

- [ ] **Step 4: Otherwise write the selected optimisation plan**

The separate plan must select exactly one row:

| Adjacent stage                          | Permitted direction                                          | Mandatory invariant                                                                        |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| process start to `loading-visible`      | remove launcher-owned synchronous work before window display | bundled exact-URL loading page remains first visible surface                               |
| `loading-visible` to `home-admitted`    | remove redundant bounded reads                               | all unknown/unreadable/oversized/symlink/FIFO formats stay fail-closed                     |
| `host-spawned` to `host-ready`          | verify compile-cache hits or defer non-ready Host work       | independent process, bootstrap capability, lease, profile reconciliation, Safe Mode remain |
| `surface-loaded` to `official-ui-ready` | profile official renderer or remove launcher blocking        | no DSH/render business logic moves into Electron Main; loopback/auth guards remain         |

Include a failing behavior test, exact affected files, baseline stage P95, target of at least 15%, and all relevant M1-M4 regression commands.

- [ ] **Step 5: Verify the decision document**

Run: `corepack pnpm@11.7.0 check:docs`

Expected: PASS and no unresolved placeholder or unselected alternative remains.

- [ ] **Step 6: Commit**

```bash
git add docs/validation/m6-acceptance.md docs/superpowers/plans/2026-09-07-m6-selected-optimisation.md
git commit -m "docs: select measured startup optimisation"
```

If no optimisation plan was created, stage only the acceptance record and use commit message `docs: record m6 startup baseline`.

### Task 5: Implement and verify the selected optimisation, if any

**Files:**

- Follow exactly: `docs/superpowers/plans/2026-09-07-m6-selected-optimisation.md`
- Modify: `docs/validation/m6-acceptance.md`
- Generated: before/after `release/startup-performance.json` copies under `release/evidence/`

**Interfaces:**

- Consumes: one approved selected-stage plan and the baseline report.
- Produces: one optimised packaged candidate or a recorded target miss that keeps the baseline candidate.

- [ ] **Step 1: Preserve the before report by digest**

Copy it within ignored release evidence storage and record its SHA in the acceptance document before changing production code.

- [ ] **Step 2: Execute the selected plan test-first**

Run its failing seam test, implement only the selected change, and pass the focused test before rebuilding.

- [ ] **Step 3: Run functional release gates**

Run:

```bash
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:shared-home
corepack pnpm@11.7.0 smoke:package
corepack pnpm@11.7.0 verify:release
```

Expected: all existing security, recovery, navigation, packaged-artifact, and cleanup gates pass.

- [ ] **Step 4: Re-run ten warm trials on the final DMG**

Run: `corepack pnpm@11.7.0 smoke:startup-performance`

Expected: selected-stage warm P95 improves by at least 15%; warm end-to-end P95 is at or below 2500 ms on the recorded machine; no other stage regresses by more than 10% without a documented explanation.

- [ ] **Step 5: Apply the promotion rule**

If either required threshold misses, record the measured result and retain the baseline artifact. Never weaken a guard, omit an outlier, or reuse a source-tree measurement to claim success.

- [ ] **Step 6: Complete the acceptance record**

Record before/after release IDs, DMG/report hashes, raw timelines, statistics, selected-stage rationale, implementation commit, all command exit codes, cleanup evidence, target result, and unverified scope.

- [ ] **Step 7: Commit**

```bash
git add docs/validation/m6-acceptance.md
git commit -m "docs: accept m6 startup performance"
```
