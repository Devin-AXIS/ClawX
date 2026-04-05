# Lumii Rollout Plan (M1-M4) with Validation Gates

## Purpose

Define phased delivery and objective release gates for Lumii secondary development, with explicit packaging/channel/upgrade checks.

## Milestones

## M1: Brand Switch Minimal Release

Deliverables:

- Lumii naming in package/build metadata
- Lumii icon/assets replacement
- global theme token baseline
- docs naming baseline

Exit criteria:

- app can install and launch on target platforms
- no regression in setup/chat/channels navigation

## M2: Lumii Plugin Integration (Core)

Deliverables:

- Lumii channel appears in Channels UI
- QR start/cancel flow wired
- account bind success path
- text and basic media outbound working

Exit criteria:

- successful scan creates usable bound account
- outbound text/image succeeds from Lumii account

## M3: Advanced Delivery and Observability

Deliverables:

- video/file send hardening
- proactive cron delivery support (`announce`)
- tool-level status/progress message strategy in Lumii channel
- improved diagnostics and error mapping

Exit criteria:

- proactive scheduled push reaches Lumii target without live-session dependency
- media error handling is user-readable and actionable

## M4: Upgrade Stability and Automation

Deliverables:

- repeatable fast-follow sync process executed multiple cycles
- conflict hotspots reduced and documented
- release checklist integrated into team process

Exit criteria:

- two consecutive upstream sync cycles completed without blocking regressions
- post-merge verification duration and conflict count are stable/acceptable

---

## Validation Gates (by Release)

## A. Build and Packaging Gates

Mandatory commands:

- `pnpm run build:vite`
- `pnpm run package`
- platform-specific package where applicable:
  - `pnpm run package:mac`
  - `pnpm run package:win`
  - `pnpm run package:linux`

Pass conditions:

- artifacts generated successfully
- installer naming and metadata reflect Lumii branding

## B. Functional Gates

Core UI smoke:

- Setup flow reachable and completable
- Chat page loads and sends baseline message
- Channels page loads and channel config modal works

Lumii channel gates:

- QR code appears on start
- cancel works and stops polling/session
- success event stores account and enables channel
- text send succeeds
- media send succeeds for at least one image file

## C. Scheduler/Delivery Gates

- Create cron job with `delivery.mode = "announce"`
- specify `channel=openclaw-lumii`, `accountId`, `to`
- verify Lumii receives proactive message
- verify invalid recipient returns explicit error

## D. Upgrade Compatibility Gates

Per sync cycle:

- Upstream merge completes with documented conflict files
- Lumii boundary policy honored (`docs/LUMII_LAYER_BOUNDARIES.md`)
- no unauthorized edits in UpstreamCore paths
- e2e smoke suite passes (`pnpm run test:e2e` or agreed reduced suite)

---

## Quality Signals and Go/No-Go

Release can proceed only if all are true:

- no blocker failures in packaging gates
- no blocker failures in Lumii channel functional gates
- no unresolved high-severity regressions from upstream sync

No-Go examples:

- QR bind path broken
- proactive delivery broken
- package artifacts missing or unusable

---

## Operational Checklist Template

- [ ] Milestone deliverables completed
- [ ] Build and packaging gates passed
- [ ] Functional channel gates passed
- [ ] Scheduler proactive delivery gate passed
- [ ] Upgrade compatibility gate passed
- [ ] Release note prepared (upstream delta + Lumii delta)
- [ ] Rollback tag confirmed

