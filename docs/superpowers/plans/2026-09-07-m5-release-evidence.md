# M5 Release Evidence and Plugin Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one verifiable release-evidence projection for an exact packaged candidate and a reusable, isolated plugin-intake rehearsal without adding distribution or market features.

**Architecture:** Pure build-time modules derive SBOM, license, artifact, compatibility, and smoke facts from existing authoritative inputs. A verifier checks all identities before `verify:release` can pass; plugin intake uses a separate declarative record and a synthetic bundle fixture.

**Tech Stack:** Node 24.11.1, pnpm 11.7.0, ESM JavaScript, Node test runner, existing staging/DMG/smoke tooling. No new runtime dependency.

**Spec:** [Post-M4 delivery design](../specs/2026-09-07-post-m4-delivery-design.md)

## Global Constraints

- Start from the exact accepted runtime artifact recorded by the DSH qualification stage; if rc.1 is rejected, use M4 `caa5c51`.
- Evidence files under `release/` are generated and ignored; committed documentation contains only sanitized summaries and hashes.
- `docs/compatibility.json`, `build/compatibility-policy.json`, `build/upstream-artifacts.json`, the lockfile, and the embedded compatibility manifest remain the version/format authorities.
- The evidence report is a projection, never a second compatibility or artifact authority.
- Do not add signing, notarization, updater, remote upload, market UI, live plugin installation, or a default third-party plugin.

---

### Task 1: Freeze the M5 scope from actual M4 evidence

**Files:**

- Create: `docs/validation/m5-scope-review.md`
- Read: `docs/validation/m1-acceptance.md`
- Read: `docs/validation/m2-acceptance.md`
- Read: `docs/validation/m3-acceptance.md`
- Read: `docs/validation/m4-acceptance.md`
- Read: `scripts/verify-runtime-tree.mjs`
- Read: `tests/smoke/package-main.mjs`

**Interfaces:**

- Consumes: accepted M1-M4 claims and their concrete test/command evidence.
- Produces: a closed M5 task list in which every retained item names the missing fact it proves.

- [ ] **Step 1: Build the evidence matrix**

Create a table with columns `topic`, `existing evidence`, `status`, `M5 delta`, and `acceptance command`. Mark at least these as already covered unless current code inspection disproves them:

- required Host/CLI/Web/helper files;
- native ABI loading under bundled runtimes;
- singleton and peer closure;
- installed-DMG boot, conversation, recovery, navigation, shutdown, and shared home;
- DMG and embedded-manifest digest binding;
- upgrade, restart, third-party bundle preservation, and downgrade refusal.

- [ ] **Step 2: Retain only four M5 deltas**

The scope review must retain:

1. SBOM generation;
2. license inventory generation;
3. unified evidence identity verification with four negative fixtures;
4. synthetic plugin-intake record and isolated rehearsal.

It must explicitly reject a duplicate health state machine, a second compatibility manifest, and speculative corruption scenarios already rejected by existing gates.

- [ ] **Step 3: Verify the document**

Run: `corepack pnpm@11.7.0 check:docs`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/validation/m5-scope-review.md
git commit -m "docs: freeze m5 evidence scope"
```

### Task 2: Generate a deterministic CycloneDX SBOM

**Files:**

- Create: `scripts/release-evidence-lib.mjs`
- Create: `scripts/release-evidence.test.mjs`
- Create: `scripts/generate-release-evidence.mjs`
- Modify: `package.json`
- Generated: `release/evidence/sbom.cdx.json`

**Interfaces:**

- Produces: `collectClosureComponents(roots, integrityByPurl)`, `createCycloneDx(components, subject)`, and `canonicalJson(value)`.
- Consumes later: Task 3 license collector and Task 4 report assembler.

- [ ] **Step 1: Write the failing component test**

Add a temporary fixture with two closure roots containing the same package instance and assert deduplication by package URL:

```js
assert.deepEqual(
  collectClosureComponents([hostRoot, cliRoot], integrityByPurl).map((entry) => entry.purl),
  ['pkg:npm/%40scope%2Fa@1.0.0', 'pkg:npm/b@2.0.0'],
)
```

Also assert that a package without name/version or an escaping symlink is rejected.

- [ ] **Step 2: Run the test and observe failure**

Run: `node --test scripts/release-evidence.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic collection and serialization**

`collectClosureComponents()` must read staged package manifests, join exact integrity from the lockfile-derived compatibility closure by purl, retain name/version/license metadata, normalize npm package URLs, sort by purl, and reject missing integrity or conflicting duplicate metadata. `canonicalJson()` must recursively sort object keys and append exactly one newline.

`createCycloneDx()` must emit CycloneDX 1.6 JSON with:

```js
{
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: { component: subject },
  components,
}
```

Do not include generation timestamps or absolute paths.

- [ ] **Step 4: Add the generator command**

Add:

```json
"generate:release-evidence": "node scripts/generate-release-evidence.mjs"
```

The command reads the fresh staged Host and CLI closure roots and writes `release/evidence/sbom.cdx.json` atomically.

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test scripts/release-evidence.test.mjs
corepack pnpm@11.7.0 package:dir
corepack pnpm@11.7.0 generate:release-evidence
```

Expected: PASS; repeating generation produces byte-identical SBOM output.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-evidence-lib.mjs scripts/release-evidence.test.mjs scripts/generate-release-evidence.mjs package.json
git commit -m "feat: generate deterministic release sbom"
```

### Task 3: Generate a reviewable license inventory

**Files:**

- Modify: `scripts/release-evidence-lib.mjs`
- Modify: `scripts/release-evidence.test.mjs`
- Modify: `scripts/generate-release-evidence.mjs`
- Generated: `release/evidence/licenses.json`

**Interfaces:**

- Produces: `createLicenseInventory(components, closureRoots)`.
- Consumes: deduplicated components from Task 2.
- Produces later: license inventory digest for Task 4.

- [ ] **Step 1: Write failing license cases**

Test exact handling for:

```js
assert.equal(byPurl['pkg:npm/a@1.0.0'].declared, 'MIT')
assert.equal(byPurl['pkg:npm/b@1.0.0'].declared, 'NOASSERTION')
assert.deepEqual(byPurl['pkg:npm/a@1.0.0'].files, ['LICENSE'])
```

Reject a license path that is a symlink or escapes its package. Do not infer a license from dependency names.

- [ ] **Step 2: Run the test and observe failure**

Run: `node --test scripts/release-evidence.test.mjs`

Expected: FAIL because the license collector is absent.

- [ ] **Step 3: Implement inventory collection**

For every component, record purl, declared SPDX expression or `NOASSERTION`, sorted in-package license filenames, and SHA-256 for each license file. Do not embed full license text in the JSON report and do not claim license compliance.

- [ ] **Step 4: Generate and verify deterministic output**

Run twice: `corepack pnpm@11.7.0 generate:release-evidence`

Expected: `release/evidence/licenses.json` is byte-identical between runs and contains no absolute path.

- [ ] **Step 5: Commit**

```bash
git add scripts/release-evidence-lib.mjs scripts/release-evidence.test.mjs scripts/generate-release-evidence.mjs
git commit -m "feat: generate release license inventory"
```

### Task 4: Bind all release evidence to one candidate

**Files:**

- Modify: `scripts/release-evidence-lib.mjs`
- Modify: `scripts/release-evidence.test.mjs`
- Modify: `scripts/generate-release-evidence.mjs`
- Create: `scripts/verify-release-evidence.mjs`
- Modify: `package.json`
- Modify: `scripts/verify-release.mjs`
- Generated: `release/evidence/release-evidence.json`

**Interfaces:**

- Produces: `createReleaseEvidence(input)` and `verifyReleaseEvidence(input)`.
- Consumes: `release/artifacts.json`, `release/package-smoke.json`, embedded compatibility manifest, SBOM, license inventory, current commit, platform, architecture, and runtime versions.

- [ ] **Step 1: Write the four failing identity fixtures**

Create in-test copies and assert exact rejection codes:

```js
assert.throws(() => verifyReleaseEvidence(staleSmoke), /EVIDENCE_SMOKE_RELEASE_MISMATCH/u)
assert.throws(() => verifyReleaseEvidence(wrongArch), /EVIDENCE_ARCH_MISMATCH/u)
assert.throws(() => verifyReleaseEvidence(replacedDmg), /EVIDENCE_ARTIFACT_DIGEST_MISMATCH/u)
assert.throws(() => verifyReleaseEvidence(missingSbom), /EVIDENCE_COMPONENT_MISSING/u)
```

- [ ] **Step 2: Run the test and observe failure**

Run: `node --test scripts/release-evidence.test.mjs`

Expected: FAIL because report assembly and verification are absent.

- [ ] **Step 3: Implement the report schema**

The report must contain only:

```js
{
  schemaVersion: 1,
  releaseId,
  sourceCommit,
  artifact: { sha256, platform, arch },
  compatibilityManifestSha256,
  runtimes: { node, electron, dsh },
  evidence: {
    sbom: { file: 'sbom.cdx.json', sha256 },
    licenses: { file: 'licenses.json', sha256 },
    packageSmoke: { file: '../package-smoke.json', sha256, passed, scenarioCount },
  },
}
```

Reject unknown fields, absolute paths, disagreement with the embedded manifest, any failed smoke scenario, and a source commit that does not match the candidate release ID.

- [ ] **Step 4: Add commands and release-chain gate**

Add:

```json
"verify:release-evidence": "node scripts/verify-release-evidence.mjs"
```

In `verify-release.mjs`, run `generate:release-evidence` and then `verify:release-evidence` after `smoke:package` and before candidate archival/rehearsal.

- [ ] **Step 5: Run focused and full gates**

Run:

```bash
node --test scripts/release-evidence.test.mjs
corepack pnpm@11.7.0 verify:release-evidence
corepack pnpm@11.7.0 verify:release
```

Expected: all positive evidence matches one candidate; all four mutations fail with their specific codes; the release chain passes.

- [ ] **Step 6: Commit**

```bash
git add scripts/release-evidence-lib.mjs scripts/release-evidence.test.mjs scripts/generate-release-evidence.mjs scripts/verify-release-evidence.mjs scripts/verify-release.mjs package.json
git commit -m "feat: verify unified release evidence"
```

### Task 5: Define and rehearse synthetic plugin intake

**Files:**

- Create: `scripts/plugin-intake.mjs`
- Create: `scripts/plugin-intake.test.mjs`
- Create: `tests/fixtures/plugin-intake/example.bundle/package.json`
- Create: `tests/fixtures/plugin-intake/example.bundle/cordis.patch.yml`
- Create: `tests/fixtures/plugin-intake/example.intake.json`
- Create: `docs/plugin-intake.md`
- Modify: `package.json`

**Interfaces:**

- Produces: `validatePluginIntake(record, bundleRoot, releaseManifest)`.
- Consumes: exact bundle bytes, source record, dependency/peer declarations, capabilities, platform evidence, and accepted release manifest.

- [ ] **Step 1: Write failing intake tests**

The accepted fixture must declare:

```json
{
  "schemaVersion": 1,
  "package": "@fixture/m5-example-bundle",
  "version": "1.0.0",
  "source": { "kind": "repository", "commit": "0123456789abcdef0123456789abcdef01234567" },
  "integrity": "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
  "license": "MIT",
  "capabilities": [],
  "validatedPlatforms": ["darwin-arm64"]
}
```

The literal integrity above is the SHA-256 of the deliberately empty payload used by the unit-level accepted record. The packaged rehearsal computes and records the real synthetic bundle directory digest with the same SHA-256 base64url encoding before validation.

Add rejection tests for unknown source, version drift, digest drift, lifecycle scripts, a duplicate singleton dependency, and no packaged evidence.

- [ ] **Step 2: Run the test and observe failure**

Run: `node --test scripts/plugin-intake.test.mjs`

Expected: FAIL because the validator does not exist.

- [ ] **Step 3: Implement the pure validator**

Validate exact package identity and digest, SPDX declaration presence, dependencies/peers against the accepted manifest singleton set, absence of install lifecycle scripts, declared capabilities, and explicit platform evidence. Return a frozen normalized record; never modify a profile.

Define the directory digest deterministically: enumerate regular files in sorted relative-path order, reject symlinks and special files, then feed the hasher each relative path, one NUL byte, that file's 64-character lowercase hexadecimal SHA-256, and one LF byte. Exclude the intake record itself so updating its declared digest does not create a cycle.

- [ ] **Step 4: Add an isolated packaged rehearsal**

Add `verify:plugin-intake` to stage the synthetic fixture only in a fresh temporary profile under a smoke-owned home, boot it through the installed candidate, assert official UI ready, and compare the user's default `desktop` profile digest before/after.

- [ ] **Step 5: Document the reusable workflow**

`docs/plugin-intake.md` must describe record creation, review, isolated validation, rejection handling, and the explicit rule that intake does not install or enable the plugin for a user.

- [ ] **Step 6: Run the gates**

Run:

```bash
node --test scripts/plugin-intake.test.mjs
corepack pnpm@11.7.0 verify:plugin-intake
corepack pnpm@11.7.0 check:docs
```

Expected: the synthetic fixture passes; every drift/unsafe fixture fails; no real profile or home is touched.

- [ ] **Step 7: Commit**

```bash
git add scripts/plugin-intake.mjs scripts/plugin-intake.test.mjs tests/fixtures/plugin-intake docs/plugin-intake.md package.json
git commit -m "feat: add isolated plugin intake verification"
```

### Task 6: Close M5 with artifact-level evidence

**Files:**

- Create: `docs/validation/m5-acceptance.md`
- Modify: `README.md`
- Modify: `docs/native-dsh-desktop-plan.md`

**Interfaces:**

- Consumes: Tasks 1-5 and one fresh full release run.
- Produces: M5 acceptance bound to exact commit, release ID, DMG, evidence hashes, and plugin fixture.

- [ ] **Step 1: Run the final chain from a clean intended tree**

Run:

```bash
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 verify:release
corepack pnpm@11.7.0 verify:plugin-intake
git diff --check
```

Expected: all commands exit 0 and all temporary resources are removed.

- [ ] **Step 2: Write the acceptance record**

Record scope matrix, baseline decision, source commit, release ID, DMG/manifest/SBOM/license/smoke hashes, negative-fixture results, plugin-intake result, commands/exit codes, cleanup evidence, and unverified scope.

- [ ] **Step 3: Update product status**

Update README and the main plan to say M5 adds release-evidence and plugin-intake assurance but does not add public distribution, signing, updater, or market support.

- [ ] **Step 4: Commit**

```bash
git add docs/validation/m5-acceptance.md README.md docs/native-dsh-desktop-plan.md
git commit -m "docs: accept m5 release evidence"
```
