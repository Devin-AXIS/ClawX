# Lumii Standalone OpenClaw Plugin Contract

## Scope

This contract defines a standalone Lumii plugin that can be installed by any OpenClaw host (not only Lumii desktop/ClawX fork).

Recommended npm package:

- `@lumii/openclaw-lumii`

Recommended plugin id:

- `openclaw-lumii`

Recommended channel id:

- `openclaw-lumii`

## Distribution and Installation

## Plugin Repository

- Dedicated repository: `openclaw-lumii-plugin`
- Independent versioning and release cadence

## `package.json` requirements

- `openclaw.extensions`: points to plugin entry (`index.js` or `dist/index.js`)
- `openclaw.channel` metadata:
  - `id`: `openclaw-lumii`
  - `label` / `selectionLabel`
  - `docsPath` / `docsLabel`
  - `order`
- `openclaw.install`:
  - `npmSpec`: `@lumii/openclaw-lumii`
  - optional `minHostVersion`

## `openclaw.plugin.json` requirements

- `id`: `openclaw-lumii`
- `channels`: `["openclaw-lumii"]`
- `configSchema`: object schema (start minimal, expand over time)

Hard rule:

- plugin manifest id and runtime exported plugin id must match.

## Runtime Registration Contract

Plugin entry should export default:

- `id`
- `name`
- `description`
- `configSchema`
- `register(api)`

Inside `register(api)`:

- `api.registerChannel({ plugin: lumiiChannelPlugin })`
- optional CLI and diagnostics hooks

## Channel Plugin Capabilities

Required channel sections:

- `config`:
  - list account ids
  - resolve account by id/default
  - determine configured status
- `auth`:
  - QR login flow
- `outbound`:
  - `sendText`
  - `sendMedia`
- `status`:
  - snapshots and summary mapping
- `reload`:
  - config prefix `channels.openclaw-lumii`

## QR Auth Contract

State machine:

- `wait`
- `scanned`
- `confirmed`
- `expired`

Behavior requirements:

- regenerate QR on expiry (bounded retries)
- return stable account identity on success
- persist credentials for account restore
- support cancellation from host UI

## Outbound Media Contract

`sendMedia` must support:

- local file paths
- remote URLs (`http/https`)

Processing requirements:

- MIME detection
- type/size validation
- upload first, then send using uploaded reference
- return platform `messageId`

Error model (minimum):

- `UNSUPPORTED_MIME`
- `MEDIA_TOO_LARGE`
- `UPLOAD_FAILED`
- `SEND_FAILED`

## Proactive Cron Delivery Contract (Mandatory)

Lumii plugin must support proactive scheduler sends (Feishu-like behavior), not only live-session replies.

Required behavior:

- Works with `delivery.mode = "announce"`
- Accepts explicit:
  - `channel`: `openclaw-lumii`
  - `accountId`
  - `to`
- Does not require ephemeral live conversation token as a hard dependency

Allowed optimization:

- if context/session tokens exist, use them
- if absent, proactive send must still work with stable target ids

Error model additions:

- `ACCOUNT_NOT_BOUND`
- `RECIPIENT_NOT_FOUND`
- `TOKEN_EXPIRED`

## Host Integration Contract (ClawX/Lumii desktop)

Desktop host responsibilities:

- ensure plugin is installed/enabled when Lumii channel is configured
- provide QR start/cancel API bridge
- map host events to renderer:
  - `channel:lumii-qr`
  - `channel:lumii-success`
  - `channel:lumii-error`
- persist channel account config and trigger gateway reload/restart

Plugin responsibilities:

- implement actual auth/messaging logic
- remain host-agnostic where possible

## Compatibility Contract

- Semantic versioning:
  - major: breaking host/plugin API or payload changes
  - minor: backward-compatible capability additions
  - patch: bugfix only
- For breaking changes, publish migration notes with:
  - config changes
  - API behavior changes
  - required host minimum version

