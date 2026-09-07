# Post-M4 Delivery Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify one traceable DSH upgrade, harden release evidence in M5, and measure then optimise packaged startup in M6 without mixing their change attribution.

**Architecture:** Three independent candidate stages share the existing M4 release and temporary-home harness. Each stage consumes an immutable accepted artifact, emits a new stage-specific acceptance record, and must pass before its output becomes the next stage's baseline.

**Tech Stack:** Node 24.11.1, pnpm 11.7.0 through Corepack, Electron 44.1.0, TypeScript, Vitest, Node test runner, existing packaged-DMG harness.

**Spec:** [Post-M4 delivery design](../specs/2026-09-07-post-m4-delivery-design.md)

## Global Constraints

- Never run a test against the user's real `~/.dsh`, Application Support directory, `/Applications`, or active app instance.
- Keep DSH upgrade, M5 evidence, and M6 performance changes in distinct branches and acceptance records.
- Use M4 artifact `m4-0.0.0-darwin-arm64-caa5c51` as the immutable fallback.
- Do not treat an npm dist-tag, untagged package, source-tree run, or manually launched app as release evidence.
- Do not add signing, notarization, updater, market, public distribution, cross-platform claims, or a default third-party plugin.

---

### Task 1: Correct the planning baseline

**Files:**

- Modify: `docs/superpowers/plans/2026-09-02-m5-distribution-hardening.md`
- Modify: `docs/superpowers/plans/2026-09-07-m6-startup-performance.md`
- Test: `scripts/verify-docs.mjs`

**Interfaces:**

- Consumes: M4 acceptance record and `release/artifacts.json`.
- Produces: unambiguous links from the two superseded plans to this roadmap and their replacement plans.

- [ ] **Step 1: Mark the old M5 plan as superseded**

Add a status note immediately below its title linking to `2026-09-07-m5-release-evidence.md`. Preserve the old body as historical scope input.

- [ ] **Step 2: Mark the old M6 plan as superseded**

Add a status note linking to `2026-09-07-m6-startup-performance-v2.md` and state that `8997ef3` is historical rather than the current candidate.

- [ ] **Step 3: Verify documentation links**

Run: `corepack pnpm@11.7.0 check:docs`

Expected: PASS with all replacement-plan and spec links resolved.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans docs/superpowers/specs
git commit -m "docs: replace post-m4 delivery roadmap"
```

### Task 2: Qualify the DSH release candidate

**Files:**

- Read and execute: `docs/superpowers/plans/2026-09-07-dsh-0.1.2-rc.1-upgrade.md`
- Create during execution: `docs/validation/dsh-0.1.2-rc.1-acceptance.md`

**Interfaces:**

- Consumes: archived M4 `caa5c51` DMG and exact upstream tag `dsh-v0.1.2-rc.1`.
- Produces: either an accepted rc.1 DMG/index or a documented no-go that preserves the M4 baseline.

- [ ] **Step 1: Execute the upgrade plan in its own branch**

Run every task in the linked plan. Do not begin M5 code while the upgrade candidate is unresolved.

- [ ] **Step 2: Record the baseline decision**

If every gate passes, record the new artifact index as the accepted input to M5. Otherwise, record `caa5c51` as the retained input and the exact failed gate.

- [ ] **Step 3: Commit the acceptance decision**

```bash
git add docs/validation docs/compatibility.json docs/upstream-baseline.md
git commit -m "docs: record dsh rc1 qualification"
```

### Task 3: Deliver M5 release evidence

**Files:**

- Read and execute: `docs/superpowers/plans/2026-09-07-m5-release-evidence.md`
- Create during execution: `docs/validation/m5-scope-review.md`
- Create during execution: `docs/validation/m5-acceptance.md`

**Interfaces:**

- Consumes: the exact accepted runtime artifact from Task 2.
- Produces: verified SBOM, license inventory, unified release evidence, and synthetic plugin-intake proof.

- [ ] **Step 1: Execute the M5 plan in its own branch**

Start with the scope review. Remove proposed checks that the M4 acceptance record already proves.

- [ ] **Step 2: Promote only a self-consistent report set**

Require `verify:release-evidence` and all four negative fixtures to pass against the same candidate identity.

- [ ] **Step 3: Commit the acceptance record**

```bash
git add docs/validation/m5-scope-review.md docs/validation/m5-acceptance.md
git commit -m "docs: accept m5 release evidence"
```

### Task 4: Measure and optimise M6 startup

**Files:**

- Read and execute: `docs/superpowers/plans/2026-09-07-m6-startup-performance-v2.md`
- Create during execution: `docs/validation/m6-acceptance.md`

**Interfaces:**

- Consumes: the M5 accepted packaged artifact without changing its dependency baseline during measurement.
- Produces: raw initialization/warm timelines and, only when justified, one optimised candidate.

- [ ] **Step 1: Execute measurement tasks first**

Complete the timeline contract, packaged harness, one initialization run, and ten warm runs before selecting production work.

- [ ] **Step 2: Apply the decision gate**

If no adjacent stage is stable and dominant, stop with a measurement-only acceptance record. Otherwise execute exactly one optimisation task from the M6 plan.

- [ ] **Step 3: Run final release verification**

Run:

```bash
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 test:integration
corepack pnpm@11.7.0 test:shared-home
corepack pnpm@11.7.0 smoke:package
corepack pnpm@11.7.0 verify:release
corepack pnpm@11.7.0 smoke:startup-performance
```

Expected: all functional gates pass; the performance report binds to the final DMG SHA; no process, lease, mount, installation, home, or `userData` fixture survives.

- [ ] **Step 4: Commit the acceptance record**

```bash
git add docs/validation/m6-acceptance.md
git commit -m "docs: accept m6 startup performance"
```

## Stop conditions

- Stop the upgrade at the first missing package, provenance mismatch, incompatible direct API, unhandled format, migration failure, or release regression.
- Stop M5 promotion when any evidence component names a different release ID, architecture, digest, or source commit.
- Stop M6 optimisation when the measurements are unstable, no stage dominates, or the proposed change weakens an M1-M4 invariant.
- Never reinterpret a stopped stage as passed; record it as retained-baseline or measurement-only evidence.
