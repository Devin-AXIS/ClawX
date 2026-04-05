# Lumii Brand Configuration Touchpoint Map

## Objective

Define where branding values live and where they should be consumed, so future upstream syncs do not require broad string/theme rewrites.

## Source of Truth

- Brand config module: `src/brand/config.ts`

This module should provide:

- Product naming (`Lumii`)
- Package/app identifiers
- Website/support metadata
- Theme token defaults

## Current Touchpoints to Migrate/Control

## Build and Packaging

- `package.json`
  - `name`, `description`, `author`
- `electron-builder.yml`
  - `appId`
  - `productName`
  - installer labels and Linux metadata text

## UI Theme and Styling

- `src/styles/globals.css`
  - root and dark theme token defaults
- optional future: a theme adapter that reads `lumiiBrandConfig.theme`

## UI Copy and Product Labels

- `src/i18n/locales/**`
  - app name references and product wording
- page-level headings with hardcoded brand names

## Static Assets

- `resources/icons/**`
- `src/assets/**` (logos and brand illustrations)

## Public Docs

- `README.md`
- `README.zh-CN.md`
- `README.ja-JP.md`

## Migration Rules

- Do not hardcode `ClawX` / `Lumii` strings in new code paths.
- Read brand identity from `src/brand/config.ts` in new/modified components.
- Keep theme color changes token-based; avoid one-off hex replacements in components.

## Suggested Adoption Order

1. Packaging metadata (`package.json`, `electron-builder.yml`)
2. Icons/resources swap
3. Theme token remap in `globals.css`
4. i18n text refresh
5. optional component-level brand config consumption

## Review Checklist

- [ ] New UI copy does not hardcode old brand
- [ ] Theme changes are tokenized
- [ ] Packaging identity matches Lumii values
- [ ] Docs and screenshots use Lumii naming

