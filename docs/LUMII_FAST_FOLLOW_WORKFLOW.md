# Lumii Fast-Follow Workflow (ClawX Upstream)

## Goal

Enable weekly/bi-weekly upstream sync with controlled risk, minimal merge pain, and predictable release cadence.

## Branching Model

- `upstream-sync`:
  - Tracks pure upstream sync commits only.
  - No Lumii custom code.
- `lumii-main`:
  - Release branch for Lumii desktop app.
  - Contains Lumii BrandLayer + IntegrationLayer patches.
- Optional short-lived branches:
  - `sync/<yyyy-mm-dd>` for each sync cycle.
  - `release/<version>` for stabilization.

## Sync Cadence

- Default: every 1-2 weeks.
- Emergency sync: security fixes, breaking upstream channel/runtime changes.

## Per-Cycle Procedure

## 1) Update `upstream-sync`

1. Fetch upstream remote.
2. Merge/rebase upstream target branch into `upstream-sync`.
3. Run baseline checks:
   - install/init
   - typecheck
   - core build/package smoke

## 2) Merge into `lumii-main`

1. Create `sync/<date>` from `lumii-main`.
2. Merge `upstream-sync` into `sync/<date>`.
3. Resolve conflicts only according to boundary doc:
   - `docs/LUMII_LAYER_BOUNDARIES.md`
4. Re-apply Lumii overlays only in approved files.

## 3) Verification Gates

Required before merge to `lumii-main`:

- Build gates:
  - `pnpm run build:vite`
  - `pnpm run package` (or platform-specific package command)
- Functional gates:
  - Setup flow opens and completes
  - Channels page loads and edits config
  - Chat page basic send/receive works
  - Lumii channel entry points compile and route correctly
- Regression gates:
  - lint/typecheck clean
  - existing e2e smoke tests pass

## 4) Release

1. Merge `sync/<date>` to `lumii-main`.
2. Tag release (`lumii-vX.Y.Z`).
3. Build artifacts and publish.
4. Record release note sections:
   - upstream changes absorbed
   - Lumii-specific changes
   - known compatibility constraints

## Conflict Playbook

When a file conflicts:

1. Check layer ownership first:
   - BrandLayer => keep Lumii identity, adopt upstream behavior if non-brand.
   - IntegrationLayer => preserve Lumii channel wiring, adopt upstream framework changes.
   - UpstreamCore => prefer upstream; re-introduce Lumii logic through isolated extension points.
2. Never duplicate hotfix logic in multiple places; centralize once.
3. Add post-merge note with:
   - conflicted file path
   - resolution rationale
   - follow-up cleanup tasks

## Required Checklists

## Sync Checklist

- [ ] Upstream commit range documented
- [ ] `upstream-sync` updated and validated
- [ ] Merge completed in `sync/<date>`
- [ ] Boundary policy respected
- [ ] Build + smoke + regression gates passed
- [ ] Release notes drafted

## Rollback Checklist

- [ ] Previous known-good tag identified
- [ ] Rollback artifacts validated
- [ ] Communication note prepared
- [ ] Hotfix branch opened for failed sync root cause

