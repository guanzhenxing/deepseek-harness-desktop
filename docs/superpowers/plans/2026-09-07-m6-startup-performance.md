# M6 Startup Performance and Observability Plan

> **Status:** Superseded by [M6 startup performance V2](2026-09-07-m6-startup-performance-v2.md) and the [post-M4 delivery roadmap](2026-09-07-post-m4-delivery-roadmap.md). Its `8997ef3` baseline is historical; the accepted M4 artifact is `caa5c51` unless a later qualified candidate replaces it.

> **For agentic workers:** M6 starts from an accepted M4 candidate, not from a user's live home or application data. Before implementing a selected optimisation, use `superpowers:writing-plans` to create a focused implementation plan and `superpowers:executing-plans` to execute it task-by-task.

**Goal:** Make daily macOS startup measurably faster while preserving M1–M4 home admission, lease, recovery, navigation and packaged-artifact guarantees.

**Architecture:** Add a smoke-only monotonic startup timeline owned by Electron Main. It records the launcher, admission, Host and renderer boundaries already present in the product without moving DSH business logic into Electron Main. A packaged-DMG benchmark reuses the existing temporary installation, userData and home fixtures; normal launches emit no timing data and accept no new userData override.

**Tech Stack:** Electron 44, Node 24.11.1, TypeScript, Vitest, the existing `runInstalledApp` packaged-app harness and the M4 `verify:release` chain. No dependency upgrade is in scope.

**Spec:** User decision on 2026-09-07: start performance work as M6, measuring first and selecting an optimisation only from a measured dominant stage. The M4 candidate baseline is `m4-0.0.0-darwin-arm64-8997ef3` / code commit `8997ef3`; its acceptance record is [M4 acceptance](../../validation/m4-acceptance.md).

## Global Constraints

- Scope is macOS arm64 only until another platform has a separately recorded baseline.
- Use Node 24.11.1 and pnpm 11.7.0 through Corepack; do not upgrade Electron, Node, pnpm or DSH as a performance shortcut.
- All benchmark homes, userData directories, installations and DMG mounts are new temporary resources owned by the harness; do not read, write, hash or delete a real DSH home or Application Support directory.
- M1–M4 lease, admission, recovery, Safe Mode, packaged-artifact, external-navigation and shutdown semantics are mandatory regression gates.
- Keep performance telemetry smoke-only, path-free and local. It must not create a user-facing setting, persistent analytics record, network request or new production environment override.

## Status and Phase Boundary

- Status: planned; this document changes neither M4 code nor its candidate status.
- M6 is not a prerequisite for M4 `candidate-verified`, the current manual-observation period, M5, or any existing release decision.
- M6 may be scheduled after M5 in the roadmap. If it starts before M5, it still uses only the M4 candidate baseline and must not assume an M5 report, tool or artifact exists.
- All automated measurements use a new temporary installation copy, a temporary userData directory and a temporary DSH home. They never launch against `~/.dsh`, an existing Application Support directory, `/Applications`, or `release/dist` while a user instance is running.
- First profile/runtime initialization and daily warm startup are separate populations. No report may average them together or use cold initialization to claim daily-startup performance.
- The loading page remains feedback only. It must not delay Host bootstrap beyond its own successful `loadFile()` completion, conceal a failed Host, or become a substitute for an interactive-ready measurement.

## Known Baseline and Questions

M4 eliminated the known admission regression by changing zstd inspection from per-frame reads to a 64 KiB forward reader: the observed real-home inspection changed from 4726 ms to 195 ms. It also enables Node's on-disk Host compile cache and displays a loading page while Host boot proceeds. The remaining end-to-end daily-startup number is not yet a valid isolated measurement.

M6 answers these questions in order:

1. How long elapses from launcher process start to a visible loading page?
2. How much of the remaining time is lease/admission, Host spawn and ready, BrowserWindow surface replacement, or official UI interactivity?
3. Is the selected stage stable across at least three warm starts of the same packaged installation and temporary home?
4. Which one change reduces the measured dominant stage without weakening a security or recovery invariant?

## Work Package 1: Smoke-Only Timeline Contract

- [ ] Add one supported smoke mode named `startup-perf` to the existing smoke-mode allowlist. It must require the same checked temporary userData directory as all other supported smoke modes.
- [ ] In Electron Main, capture monotonic elapsed milliseconds from module entry and emit only these ordered smoke events: `launcher-ready`, `loading-visible`, `home-admitted`, `host-spawned`, `host-ready`, `surface-loaded`, and `official-ui-ready`.
- [ ] Define each event at the existing boundary that owns the fact: `loading-visible` only after `BrowserWindow.loadFile()` returns and the window is visible; `home-admitted` only after `runHomeCompatibilityChain()` resolves; `host-spawned` only after the utility process reports spawn; `host-ready` only after `HostSupervisor.start()` resolves; `surface-loaded` only after `loadSurface()` resolves; and `official-ui-ready` only after the existing `waitForOfficialUi()` predicate resolves.
- [ ] Emit no stage detail, home path, authenticated surface URL, capability, cookie, profile content or user data in the timeline. Each event contains a fixed stage name and a non-negative integer elapsed milliseconds value.
- [ ] Add focused unit coverage for the timeline schema/order and the `startup-perf` temporary-directory admission. The test must fail if an event is omitted, reordered, exposes an extra field, or a non-temporary userData override is accepted.

Acceptance: a normal launch produces no performance report; an isolated `startup-perf` run produces exactly one complete, ordered, path-free timeline and still quits through the ordinary Host-stop/lease-release chain.

## Work Package 2: Packaged Candidate Measurement Harness

- [ ] Add an installed-DMG scenario alongside `installed-loading-page` in `tests/smoke/package-main.mjs`; it must use `installFromDmg` and `runInstalledApp`, not the workspace Electron binary.
- [ ] Run one explicitly labeled initialization trial using a fresh temporary home and userData. Record its timeline separately; it is diagnostic evidence only, never compared against the warm budget.
- [ ] Run three warm trials sequentially with the same already-initialized temporary home and userData, waiting for each app process and home lease to be fully released before launching the next trial.
- [ ] Write an ignored `release/startup-performance.json` report containing candidate release ID, DMG SHA-256, macOS/architecture, Node/Electron versions, each individual timeline, warm median, warm P95 and stage medians. No absolute filesystem paths or tokens may enter the report.
- [ ] Make the harness fail when a required event is missing, elapsed values regress, a warm run is not isolated, a process/lease survives, or the report's candidate identity disagrees with `release/artifacts.json`. Do not make a fixed wall-clock budget a universal CI failure until M6 has recorded a reproducible machine baseline.

Acceptance: the report lets a reviewer distinguish initialization, warm total time and every stage for the exact installed artifact; it proves isolation and cleanup using the existing packaged-app helpers.

## Work Package 3: Measurement Review and Optimisation Selection

- [ ] Record a baseline on the M6 execution machine with the exact DMG SHA and the three warm timelines. Add the result to `docs/validation/m6-acceptance.md`; do not reuse a number from a different candidate or from a manually launched app.
- [ ] Select exactly one dominant stage using warm P95. Use the following decision table; if no stage dominates or measurements are unstable, stop after documenting the result rather than changing launch behavior.

| Measured dominant stage                | Permitted optimisation direction                                                                                                                  | Non-negotiable constraint                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `home-admitted`                        | Reduce redundant metadata reads or bounded-reader overhead, then benchmark against homes of different session counts.                             | Unknown, unreadable, symlink, FIFO, oversized or unsupported data remains fail-closed; do not skip format inspection.              |
| `host-spawned` → `host-ready`          | Verify compile-cache hit/miss behavior, avoid duplicate runtime imports, or defer work that is not needed before the Host-control ready contract. | Keep the independent utility process, bootstrap capability, profile reconciliation, lease ownership and Safe Mode boundary intact. |
| `surface-loaded` → `official-ui-ready` | Profile the official surface's renderer work and remove launcher-owned blocking work from the critical path.                                      | Do not put renderer/DSH business logic in Electron Main or weaken loopback/authenticated navigation checks.                        |
| `launcher-ready` → `loading-visible`   | Reduce Electron-main synchronous startup work or resource lookup before window creation.                                                          | The loading page must remain bundled, exact-URL guarded and visibly replaceable by the surface.                                    |

- [ ] Create a short, separate implementation plan for the selected row before changing production behavior. The plan must state the measured baseline, a target improvement for that stage, the exact tests and the affected M1–M4 invariants.

Acceptance: an optimisation is chosen only from a recorded dominant stage and has a dedicated, test-first implementation plan. A flat or noisy result is a valid M6 finding, not permission to speculate.

## Work Package 4: Optimisation Delivery and Regression Thresholds

- [ ] Write a failing regression test at the real seam of the chosen bottleneck before implementation; the test must exercise the measured behavior, not assert an implementation detail.
- [ ] Implement the smallest change that improves the selected stage. Keep a before/after report generated from the same packaged-DMG harness and execution machine conditions.
- [ ] Require the selected stage's warm P95 to improve by at least 15% and require the warm end-to-end P95 to remain at or below 2500 ms on the recorded execution machine. If hardware, upstream runtime or system load makes that target unreproducible, record the measured limit and do not label the target passed.
- [ ] Run `pnpm check`, the affected real Host integration/smoke tests, `pnpm smoke:package`, and `pnpm verify:release`. Re-run the three warm trials after the final DMG is built, because a source-tree measurement is not release evidence.

Acceptance: the final candidate includes a before/after stage comparison, passes all M1–M4 regression gates and has no surviving temporary process, home lease, DMG mount or installation directory.

## M6 Completion Record

M6 adds `docs/validation/m6-acceptance.md` with: the M4 baseline candidate and source commit; execution hardware/OS/runtime; raw initialization and warm timelines; warm median/P95; selected-stage rationale; before/after candidate IDs and DMG SHAs; commands and exit codes; regression/security/recovery results; cleanup evidence; and any unmet threshold or unverified scope.

M6 does not change historical M4 acceptance. If M6 produces a new candidate, its release evidence records the new commit and artifact; it does not retroactively relabel `8997ef3`.
