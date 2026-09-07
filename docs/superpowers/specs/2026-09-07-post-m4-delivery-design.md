# Post-M4 Delivery Design: DSH Upgrade, M5, and M6

- Date: 2026-09-07
- Status: approved direction; implementation not started
- Current accepted artifact: `m4-0.0.0-darwin-arm64-caa5c51`
- Current DSH baseline: `dsh-v0.1.2-alpha.3` @ `dd6322d604e00eec1ba5e0c8541159906a21094a`

## 1. Decision

Post-M4 work is split into three independently reviewable changes:

1. qualify `dsh-v0.1.2-rc.1` as a candidate runtime upgrade;
2. deliver M5 release evidence and plugin-intake hardening on the accepted runtime;
3. measure and improve startup in M6 on the exact accepted packaged artifact.

The order is `upgrade qualification -> M5 -> M6`. A failed upgrade qualification does not block M5 or M6: they continue from the frozen M4 artifact and record that baseline explicitly. A successful qualification replaces the runtime baseline only after its own packaged-artifact, migration, downgrade-refusal, and regression gates pass.

## 2. Why the work stays separate

The DSH upgrade owns upstream provenance, runtime APIs, dependency closure, and persistent-format compatibility. M5 owns release-time evidence derived from those facts. M6 owns smoke-only timing observations and one measured optimisation. Combining them would make a changed startup time, broken session, or mismatched artifact impossible to attribute reliably.

The chosen upgrade target is `dsh-v0.1.2-rc.1`, not the highest alpha observed in a registry. It has an immutable upstream tag and a published npm family. `0.1.3-alpha.1` changes Session persistence ownership, writes Session format v2, and documents a performance regression; it is therefore outside this delivery train. A later `0.1.3` candidate requires a new qualification plan after an immutable tag, complete package family, release notes, and migration evidence exist.

## 3. Artifact lineage

Every stage consumes one immutable predecessor and produces one candidate:

| Stage                 | Previous                   | Candidate                          | Promotion condition                                                  |
| --------------------- | -------------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| Upgrade qualification | M4 `caa5c51` DMG           | DSH `0.1.2-rc.1` DMG               | Full release chain and real cross-version rehearsal pass             |
| M5                    | Accepted runtime candidate | Same runtime plus evidence tooling | Evidence verifier rejects all four stale/mixed fixtures              |
| M6 baseline           | Accepted M5 candidate      | Measurement report only            | Ten isolated warm runs bind to the same DMG SHA                      |
| M6 optimisation       | M6 baseline DMG            | One optimised DMG                  | Selected-stage warm P95 improves at least 15% with regressions green |

Historical artifacts and acceptance records are immutable. A new stage writes a new release ID and does not relabel `caa5c51` or earlier candidates.

## 4. Upgrade boundary

The upgrade changes all `@deepseek-ai/dsh*` packages as one exact family and keeps `@deepseek-ai/cordis` and React on independently verified singleton axes. It re-derives compatibility facts from published code instead of mechanically replacing version strings.

Known `0.1.2-rc.1` format facts to verify during implementation are:

- credentials document version remains 1;
- Session JSONL format remains 0;
- workspace storage domain remains 2;
- session projection cache writes version 5 and declares versions 3 and 4 readable;
- settings and profile manifests remain provider-build identified because upstream exposes no numeric schema for them.

Because the projection cache writer changes from 4 to 5, the candidate must explicitly decide and test its downgrade policy. The cache is derived and rebuildable while credentials, settings, Session JSONL, workspace storage, and profile bytes remain on their existing durable formats, so the candidate keeps data epoch 1. Its format policy declares projection-cache v4 and v5 readable and v5 writable; its marker-consistency check treats two IDs as compatible only when one release rule explicitly lists both as readable. The old M4 policy knows only v4 and therefore refuses a v5 cache or an rc.1 marker/inspection disagreement. If qualification finds any changed non-cache persistent format, it stops: a separate migration milestone and ADR are required instead of extending this upgrade.

## 5. M5 boundary

M5 is release engineering, not a second compatibility authority. It derives three ignored artifacts from the staged Host/CLI closure and existing release facts:

- `release/evidence/sbom.cdx.json`;
- `release/evidence/licenses.json`;
- `release/evidence/release-evidence.json`.

The evidence report binds the source commit, release ID, DMG digest, embedded compatibility digest, platform/architecture, runtime versions, SBOM digest, license digest, and packaged-smoke result. Verification rejects a stale smoke report, wrong architecture, replaced artifact, or missing evidence file.

M5 also defines a reusable plugin-intake record and validates one synthetic bundle in an isolated profile. It does not install a community plugin, alter the default profile, add a market, sign artifacts, notarize the app, or create an updater.

## 6. M6 boundary

M6 adds a `startup-perf` smoke mode admitted only with the existing checked temporary `userData` convention. Normal launches emit no timing data. The launcher records cumulative monotonic elapsed milliseconds for exactly these boundaries:

1. `launcher-ready` after Electron readiness and single-instance admission;
2. `loading-visible` after the bundled loading page is loaded and visible;
3. `home-admitted` after the compatibility chain resolves;
4. `host-spawned` when `HostSupervisor` emits `starting`;
5. `host-ready` when `HostSupervisor.start()` resolves;
6. `surface-loaded` when the launcher surface load resolves;
7. `official-ui-ready` when the existing official-UI predicate resolves.

One initialization trial and ten sequential warm trials use the same newly created temporary installation, home, and `userData`. Every warm launch begins only after the prior launcher, Host, descendants, and home lease have ended. The report uses nearest-rank P95, retains every raw timeline, and keeps initialization separate from warm results.

M6 selects exactly one dominant adjacent stage. If results are unstable or no stage dominates, measurement is a valid completion outcome and production startup behavior remains unchanged. If an optimisation proceeds, it receives a separate test-first task and must preserve every M1-M4 security, recovery, navigation, and shutdown invariant.

## 7. Failure and rollback policy

- Upgrade failure: discard the candidate branch; keep M4 `caa5c51` as the runtime baseline.
- M5 evidence failure: no product runtime change is promoted; regenerate evidence only from a clean rebuilt candidate.
- M6 measurement instability: record the raw result and stop before optimisation.
- M6 regression or target miss: keep the baseline artifact; do not weaken admission, lease, Host isolation, recovery, or UI-ready definitions to reach the target.

No automated step reads, writes, hashes, migrates, or deletes the user's real `~/.dsh`, Application Support directory, `/Applications`, or an active installation.

## 8. Completion definition

The delivery train is complete when:

- one runtime baseline is explicitly accepted, whether M4 `alpha.3` or the qualified `rc.1` candidate;
- M5 produces a single verified evidence projection and a reusable synthetic plugin-intake rehearsal;
- M6 records reproducible packaged-artifact startup timelines and either delivers one proven optimisation or honestly records that no stable dominant stage exists;
- all acceptance records name exact commits, release IDs, hashes, commands, exit codes, cleanup evidence, and unverified scope.
