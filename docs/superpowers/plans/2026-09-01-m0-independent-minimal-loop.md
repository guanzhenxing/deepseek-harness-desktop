# M0 Independent Minimal Loop Implementation Plan

> **For Codex:** Execute this plan test-first in the `feat/m0-desktop-shell` worktree. Keep each task independently reviewable and do not pull M1 home-lease or future market/remote/updater behavior into M0.

**Goal:** Deliver the first observable desktop vertical slice: reconcile an isolated `desktop` profile, start DSH in an independent Electron utility process, publish the authenticated official Web UI through the narrow Host-control protocol, render it in a hardened BrowserWindow, and keep the Electron shell alive when the Host exits.

**Architecture:** `desktop-launcher` owns Electron identity, process creation, navigation policy and the recovery window. `shell-core` composes launcher-owned lifecycle ports. `host-supervisor` owns the Host-control state machine and bounded shutdown but has no window or profile authority. `profile-manager` is Electron-free and owns deterministic profile reconciliation. The Host runner boots only public DSH packages and provides a publisher-neutral `desktopSurface`; `desktop-plugin` turns the official DSH connection into one normal loopback surface. Future market, remote and updater capabilities can add separately versioned contracts and adapters without widening Host-control.

**Technology baseline:** Node.js 24.11.1, pnpm 11.7.0, TypeScript, Vitest, Electron 44.1.0, DSH `dsh-v0.1.2-alpha.3` (`dd6322d`). Runtime dependencies use exact versions in the lockfile. TypeScript emits ESM without bundling DSH so Cordis retains one runtime instance.

**M0 data boundary:** All tests and the development launcher use an explicit temporary or Electron `userData`-scoped home. M0 must not read or modify `~/.dsh`. Shared-home lease semantics begin in M1.

---

## Task 1: Establish the TypeScript workspace and executable gates

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `tsconfig.json`
- Create: `eslint.config.js`
- Create: `.prettierignore`
- Create: `.prettierrc.json`
- Create: `vitest.config.ts`
- Create: `scripts/verify-boundaries.mjs`
- Test: `scripts/verify-boundaries.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/development.md`

1. Add an initially failing boundary test proving lower-level packages cannot import Electron or a launcher path.
2. Implement the smallest static dependency checker and run the test until green.
3. Add exact development dependencies and root commands: `build`, `format:check`, `lint`, `typecheck`, `test:unit`, `test:integration`, `smoke:dsh-ui`, and `check`.
4. Add strict shared TypeScript/Vitest/ESLint/Prettier configuration and project references.
5. Make CI install with the frozen lockfile and run `pnpm check`.
6. Commit as `chore: establish m0 workspace gates`.

## Task 2: Implement Host-control contracts first

**Files:**

- Create: `packages/desktop-contracts/package.json`
- Create: `packages/desktop-contracts/tsconfig.json`
- Create: `packages/desktop-contracts/src/host-control.ts`
- Create: `packages/desktop-contracts/src/index.ts`
- Create: `packages/desktop-contracts/test/host-control.test.ts`
- Create: `packages/desktop-contracts/test/fixtures/host-old-launcher-new.ts`
- Create: `packages/desktop-contracts/test/fixtures/host-new-launcher-old.ts`

1. Write failing tests for strict envelopes, exact direction, safe monotonic sequences, protocol/minor negotiation, capability and lease checks, Host identity, transition ordering, purpose/mode, terminal states and bounded strings.
2. Write failing surface tests for loopback-only URLs, explicit nonzero ports, no userinfo/fragment and stable origin extraction.
3. Write failing redaction tests proving capabilities, authenticated URLs and home paths never reach ordinary diagnostics.
4. Implement closed runtime schemas and typed parse/validation errors; do not expose a generic method-call message.
5. Add launcher-new/Host-old and launcher-old/Host-new minor-0 fixtures.
6. Run unit, type and dependency-boundary checks.
7. Commit as `feat: add host control contracts`.

## Task 3: Implement deterministic profile reconciliation

**Files:**

- Create: `packages/profile-manager/package.json`
- Create: `packages/profile-manager/tsconfig.json`
- Create: `packages/profile-manager/src/index.ts`
- Create: `packages/profile-manager/src/profile-ref.ts`
- Create: `packages/profile-manager/src/reconcile.ts`
- Create: `packages/profile-manager/test/profile-ref.test.ts`
- Create: `packages/profile-manager/test/reconcile.test.ts`

1. Write failing tests for normalized `ProfileRef`, invalid names and explicit test-home containment.
2. Write failing integration tests for missing profile initialization, desired prefix repair, duplicate owned bundle removal, third-party order preservation, unrelated profile preservation and idempotence.
3. Implement `reconcileDesktopProfile(ref)` with the public DSH profile format and atomic manifest replacement. Do not import the monolithic `@deepseek-ai/dsh-app-boot` root into profile-manager because that would evaluate the Host boot graph in Electron Main; keep parity tests for the small profile-format semantics used here. The owned prefix is exactly `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@dsh-desktop/desktop-plugin`.
4. Return before/after SHA-256 revisions and changed files so later recovery can reuse the same authority; do not add generation journals in M0.
5. Prove tests never touch the real DSH home.
6. Commit as `feat: reconcile desktop profile`.

## Task 4: Implement the Electron-free desktop bundle plugin

**Files:**

- Create: `packages/desktop-plugin/package.json`
- Create: `packages/desktop-plugin/tsconfig.json`
- Create: `packages/desktop-plugin/src/index.ts`
- Create: `packages/desktop-plugin/src/runtime.ts`
- Create: `packages/desktop-plugin/test/runtime.test.ts`
- Create: `packages/desktop-plugin/test/bundle.test.ts`

1. Write failing tests that the bundle patch composes after the official Web app and forces `openBrowser: false`, `printUrl: false` without removing the full upstream Web runtime config.
2. Write failing service tests for one-shot scheduling after `connection` and `webServer` become available, readable degradation without `desktopSurface`, and rejection of any host other than `127.0.0.1`.
3. Implement a Cordis plugin that calls public `connection.authenticatedUrl()` and publishes `{ kind: 'loopback', url }` through the narrow `desktopSurface.schedule()` service.
4. Keep Electron, launcher product state, profile writes and future capabilities out of the package.
5. Commit as `feat: publish desktop dsh surface`.

## Task 5: Implement supervisor and Host runner lifecycle

**Files:**

- Create: `packages/host-supervisor/package.json`
- Create: `packages/host-supervisor/tsconfig.json`
- Create: `packages/host-supervisor/src/index.ts`
- Create: `packages/host-supervisor/src/supervisor.ts`
- Create: `packages/host-supervisor/src/host-runner.ts`
- Create: `packages/host-supervisor/src/transport.ts`
- Create: `packages/host-supervisor/test/supervisor.test.ts`
- Create: `packages/host-supervisor/test/host-runner.integration.test.ts`
- Create: `packages/host-supervisor/test/fixtures/fake-host.mjs`

1. Write a fake-process test matrix for hello timeout, identity mismatch, successful surface/ready, pre-ready exit, post-ready crash, duplicate stop, dispose acknowledgment, terminate timeout and force-kill escalation.
2. Implement a transport-neutral supervisor whose only side effects flow through a process adapter and clock.
3. Write an isolated-home integration test that runs the real Host runner in a separate PID and observes a real DSH authenticated surface.
4. Implement Host boot using public DSH APIs only: load the reconciled profile, compose bundle/profile/home patches, inject `desktopSurface`, `launchEnvironment` and cmdline arguments for `127.0.0.1` with an ephemeral port, then call `boot()` inside the Host runner.
5. Keep the bootstrap capability on the private message port; never put it in argv, environment, stdout or files.
6. Dispose the returned Cordis context before acknowledging shutdown.
7. Commit as `feat: supervise independent dsh host`.

## Task 6: Compose the hardened Electron shell

**Files:**

- Create: `packages/shell-core/package.json`
- Create: `packages/shell-core/tsconfig.json`
- Create: `packages/shell-core/src/index.ts`
- Create: `packages/shell-core/src/lifecycle.ts`
- Create: `packages/shell-core/src/navigation.ts`
- Create: `packages/shell-core/test/lifecycle.test.ts`
- Create: `packages/shell-core/test/navigation.test.ts`
- Create: `apps/desktop-launcher/package.json`
- Create: `apps/desktop-launcher/tsconfig.json`
- Create: `apps/desktop-launcher/src/main.ts`
- Create: `apps/desktop-launcher/src/host-entry.ts`
- Create: `apps/desktop-launcher/src/electron-host-process.ts`
- Create: `apps/desktop-launcher/src/recovery.html`
- Create: `apps/desktop-launcher/test/main.integration.test.ts`

1. Write failing pure tests for shell lifecycle, allowed main-frame origin, popup denial and Host-crash transition to launcher-owned recovery.
2. Implement `shell-core` against narrow window/profile/supervisor ports; it must not import DSH packages.
3. Implement the Electron adapter with one-instance identity, a `utilityProcess.fork()` Host, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, denied permissions, blocked cross-origin navigation and no privileged renderer IPC.
4. Store the M0 development home under this app's `userData/m0-dsh-home`; reject a path equal to the platform default DSH home.
5. On Host failure destroy the stale Web contents and load the packaged recovery page while Electron remains alive.
6. Commit as `feat: add independent electron desktop shell`.

## Task 7: Prove the M0 vertical slice

**Files:**

- Create: `tests/smoke/dsh-ui.mjs`
- Create: `tests/smoke/host-crash.mjs`
- Create: `tests/smoke/assert-cleanup.mjs`
- Modify: `README.md`
- Modify: `docs/development.md`
- Modify: `docs/architecture.md`
- Modify: `docs/native-dsh-desktop-plan.md`
- Create: `docs/compatibility.json`

1. Make `smoke:dsh-ui` fail until the launcher reports a loaded official DSH main frame containing the sidebar, conversation region and settings entry.
2. Add a Host-crash smoke that terminates only the child PID, proves the launcher PID remains alive, observes the recovery page and checks no child survives final shutdown.
3. Run both smokes against a freshly created isolated home and validate the cleanup target before deleting it.
4. Record the exact Desktop/DSH/Electron/Node/pnpm compatibility facts in `docs/compatibility.json`; make docs refer to it as the source of truth.
5. Update project status and actual commands without claiming M1 shared-home or M3 packaged-app completion.
6. Run `pnpm check`, `pnpm test:integration`, `pnpm smoke:dsh-ui` and `pnpm smoke:host-crash`.
7. Commit as `test: prove m0 desktop loop`.

## Task 8: Review the milestone before handoff

1. Review the branch against `main` on two axes: repository standards and this M0 spec.
2. Run security review on URL handling, renderer preferences, permission requests, private capability transport and diagnostics redaction.
3. Verify `git diff --check`, a clean worktree, exact lockfile versions and no real-home artifacts.
4. Confirm Electron Main's dependency graph contains no DSH runtime and all six M0 packages participate in the running path.
5. Only then mark M0 complete and present merge options; do not merge or push without user direction.

## Explicitly deferred

- M1: shared `~/.dsh`, home lease, supported CLI and doctor unlock.
- M2: revision rollback, Safe Mode, recovery bridge and projection-cache isolation.
- M3: electron-builder, installed `.app`/DMG smoke, signing and notarization.
- M4: release compatibility enforcement and upgrade rehearsal.
- E2/E3/E4: updater, plugin market and remote access product capabilities.

The M0 contracts and dependency direction must leave these additions possible, but M0 does not simulate them with placeholder runtime APIs.
