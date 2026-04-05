# Lumii Fork Layer Boundaries

## Purpose

This document freezes the change boundaries for Lumii secondary development, so upstream sync conflicts stay concentrated in a small, predictable area.

## Layer Model

## BrandLayer (allowed to change frequently)

Scope: naming, visual style, icons, copywriting, packaging identity.

Primary touchpoints:

- `package.json` (app/package name, description, author metadata)
- `electron-builder.yml` (productName, appId, installer display text, artifact naming)
- `resources/icons/**` (all platform icons)
- `resources/**` (branding assets such as splash/background where applicable)
- `src/styles/globals.css` (global tokens and default palette)
- `src/i18n/**` (brand words and user-facing copy)
- `README.md`, `README.zh-CN.md`, `README.ja-JP.md` (project naming/docs)

Change policy:

- Prefer token/asset/config changes over component logic rewrites.
- Keep branding constants centralized (see `src/brand/config.ts`).

## IntegrationLayer (Lumii-specific integration, limited area)

Scope: Lumii channel entry, plugin install hooks, host-api bridge for Lumii QR and channel lifecycle.

Primary touchpoints:

- `src/types/channel.ts` (Lumii channel metadata and form model)
- `src/components/channels/**` (Lumii channel UI integration only)
- `src/pages/Channels/index.tsx` (Lumii card/list integration only)
- `electron/api/routes/channels.ts` (Lumii `/start` `/cancel` routes)
- `electron/utils/plugin-install.ts` (ensure Lumii plugin install support)
- `electron/utils/channel-config.ts` (Lumii channel config and cleanup glue)
- `src/lib/channel-alias.ts` (if Lumii needs alias mapping between UI/host channel id)

Change policy:

- Reuse existing channel framework patterns.
- Do not spread Lumii-specific behavior into unrelated pages/modules.

## UpstreamCore (avoid direct edits unless mandatory)

Scope: OpenClaw transport internals, general chat orchestration, shared provider core, unrelated channels.

Typical paths to avoid:

- `electron/gateway/**`
- `src/stores/chat.ts` (unless required for Lumii-only status rendering)
- `src/pages/Chat/**` (except isolated, guarded UI extension points)
- `shared/**` core protocol files

Exception policy:

- If a change in UpstreamCore is unavoidable, isolate behind feature flags/config and document rationale in PR notes.

## Conflict Control Rules

- Keep Lumii customizations under `docs/` + `src/brand/` + limited integration files.
- Any new Lumii behavior must identify target layer in commit/PR title:
  - `brand: ...`
  - `integration: ...`
  - `core-exception: ...`
- During upstream merges, resolve conflicts in this order:
  1. Upstream behavior correctness
  2. Lumii BrandLayer overlay
  3. Lumii IntegrationLayer glue

## Ownership Recommendation

- BrandLayer owner: Design/Frontend team
- IntegrationLayer owner: Desktop integration team
- UpstreamCore exception owner: Tech lead approval required

