# Lumii QR Channel Plugin Architecture (for OpenClaw/ClawX)

## 1. Background and Goal

This document defines the architecture for a Lumii channel plugin that behaves like the WeChat flow in ClawX:

- User clicks Lumii channel in Channels page
- Desktop app shows a QR code
- User scans and confirms on mobile
- Account is auto-bound and becomes available for messaging

The design target is to align with OpenClaw channel plugin conventions and ClawX host-side integration patterns.

---

## 2. Product Scope

### 2.1 In Scope (MVP)

- QR login and account binding
- Single account and multi-account support
- 1:1 conversation messaging
- Outbound text and media send (image/video/file)
- Cron proactive delivery support (Lumii must receive scheduled pushes from OpenClaw without a live chat session)
- Basic inbound message handling
- Gateway reload/restart compatibility after account changes

### 2.2 Out of Scope (Phase 2+)

- Group conversation routing policies
- Rich interactive cards
- Advanced moderation/audit policy
- Large-scale delivery analytics dashboard

---

## 3. Plugin Packaging Structure

Recommended plugin repository structure:

```text
openclaw-lumii-plugin/
  package.json
  openclaw.plugin.json
  index.ts
  src/
    channel.ts
    auth/
      login-qr.ts
      accounts.ts
    api/
      lumii-client.ts
    messaging/
      inbound.ts
      send.ts
      send-media.ts
    storage/
      state-store.ts
    util/
      mime.ts
      logger.ts
```

### 3.1 `openclaw.plugin.json`

Minimum expected fields:

- `id`: `"openclaw-lumii"`
- `channels`: `["openclaw-lumii"]`
- `configSchema`: plugin-level schema (can be empty object schema initially)
- Optional: `skills`, `channelConfigs`

### 3.2 `package.json` (`openclaw` field)

Must expose:

- `openclaw.extensions`: plugin entry path
- `openclaw.channel`: channel metadata (`id`, `label`, `docsPath`, `order`, etc.)
- `openclaw.install`: `npmSpec`, `localPath`, default install choice, optional host version constraints

Important: plugin id in manifest and runtime export must match.

---

## 4. Runtime Module Architecture

## 4.1 Entry (`index.ts`)

Responsibilities:

- export default plugin object (`id`, `name`, `description`, `configSchema`, `register(api)`)
- register the Lumii channel plugin via `api.registerChannel(...)`
- optionally register CLI diagnostics command(s)

## 4.2 Channel Core (`src/channel.ts`)

The channel plugin object should include:

- `id` / `meta`
- `configSchema`
- `capabilities`
- `config` (account list/resolve/configured check)
- `outbound.sendText`
- `outbound.sendMedia`
- `status` summary/snapshot builders
- `auth.login` / optional logout
- `reload` config prefixes

## 4.3 Auth Layer (`src/auth/*`)

- start QR login session
- poll login status (`wait`, `scanned`, `confirmed`, `expired`)
- auto-refresh QR when expired (bounded retries)
- persist account credentials after confirmed
- restore sessions/tokens at startup

## 4.4 Messaging Layer (`src/messaging/*`)

- inbound event parsing and recipient mapping
- outbound text send
- outbound media send (upload then deliver)
- context token/session mapping per recipient (if Lumii requires session context)
- cron-friendly proactive send path (must work without transient session-only tokens)

## 4.5 API Layer (`src/api/lumii-client.ts`)

Unified HTTP client with:

- timeout and retry policy
- error code normalization
- auth header injection
- typed request/response wrappers

## 4.6 Storage Layer (`src/storage/state-store.ts`)

Suggested state paths:

- `~/.openclaw/openclaw-lumii/accounts.json`
- `~/.openclaw/openclaw-lumii/accounts/<accountId>.json`
- optional context token maps per account

Security baseline:

- credential files set to user-only permission where supported
- no plaintext token in logs

---

## 5. ClawX Integration Flow (QR UX)

## 5.1 Start Flow

1. ClawX calls `/api/channels/lumii/start`
2. host ensures Lumii plugin is installed
3. host starts Lumii QR login session
4. host emits `channel:lumii-qr` event to renderer

## 5.2 Wait/Confirm Flow

1. host polls status in background
2. if QR expired: regenerate and emit refreshed `channel:lumii-qr`
3. if confirmed:
   - save credentials to Lumii state
   - save channel config for account
   - trigger gateway refresh/restart
   - emit `channel:lumii-success`
4. if error: emit `channel:lumii-error`

## 5.3 Cancel Flow

- renderer closes modal or user clicks cancel
- call `/api/channels/lumii/cancel`
- host cancels active session and polling

---

## 6. Media Sending Design (Critical)

OpenClaw does not directly deliver files to Lumii. The channel plugin must implement this.

`outbound.sendMedia` should:

1. resolve media source (`local path` or `https url`)
2. load/prepare file bytes
3. detect MIME and media class (image/video/audio/file)
4. validate size/type against Lumii limits
5. call Lumii upload API and get `mediaId`/`fileId`
6. call Lumii send API with recipient + uploaded media reference
7. return `messageId` to host runtime

Fallback behavior:

- if media upload fails, return structured error
- if file exceeds limit, return clear user-facing reason
- optional fallback to link-only text for unsupported types

## 6.1 Scheduled Proactive Delivery Requirement (Mandatory)

Lumii must support OpenClaw cron proactive delivery similar to Feishu-style announce mode.

Hard requirements:

- plugin outbound send must work without requiring a live conversation-only context token
- delivery payload must support explicit `channel + accountId + to` targeting
- when called by cron (`delivery.mode = "announce"`), Lumii should receive text/media normally
- if recipient target is invalid, return a clear retriable/non-retriable error code

Implementation note:

- context tokens can be used as optimization, but must not be a hard prerequisite for scheduled pushes

---

## 7. Lumii Backend Contract (Minimum)

Recommended minimum API surface:

- `POST /lumii/qr/start`
  - response: `sessionKey`, `qrCode` (content or image URL), optional expiration
- `GET /lumii/qr/status?sessionKey=...`
  - response status: `wait|scanned|confirmed|expired`
  - on confirmed: `accountId`, `token`, optional `refreshToken`, `baseUrl`, `userId`
- `POST /lumii/media/upload`
  - response: `mediaId`, `mimeType`, `size`
- `POST /lumii/message/send`
  - payload supports text/media
  - response: `messageId`
- `POST /lumii/message/send-proactive` (or equivalent behavior on `/lumii/message/send`)
  - must support proactive delivery from scheduler jobs
  - required fields: `accountId`, `to`, and content payload
- `GET /lumii/health`

Error codes should be explicit, for example:

- `TOKEN_EXPIRED`
- `QR_EXPIRED`
- `MEDIA_TOO_LARGE`
- `UNSUPPORTED_MIME`
- `ACCOUNT_NOT_BOUND`
- `RECIPIENT_NOT_FOUND`

---

## 8. Reliability and Observability

## 8.1 Retry Policy

- Short retries for transient network failures
- no retry for non-retriable auth and schema errors
- bounded retries for QR refresh and upload operations

## 8.2 Metrics/Logs

Track:

- QR start success/failure
- QR confirmation latency
- media upload success/failure by type
- outbound delivery latency and failure codes

Log hygiene:

- mask tokens and sensitive ids
- include accountId and request correlation id

---

## 9. Delivery Plan

## Phase 1 (MVP)

- plugin skeleton
- QR bind flow
- text + image send
- host integration endpoints/events

## Phase 2

- video/file send hardening
- token refresh and reconnect
- richer status and diagnostics

## Phase 3

- multi-account routing policies
- group conversation support
- operational tooling and dashboards

---

## 10. Acceptance Checklist

- [ ] Plugin package loads via OpenClaw extension mechanism
- [ ] `openclaw.plugin.json` and runtime plugin ids are consistent
- [ ] ClawX can start/cancel Lumii QR flow
- [ ] Successful scan creates account state and enables channel
- [ ] Text send works for bound account
- [ ] Media send works for image/video/file (within limits)
- [ ] Cron `announce` delivery works with explicit `channel + accountId + to` (no live session prerequisite)
- [ ] Gateway refresh/restart applies new account reliably
- [ ] Sensitive data is masked in logs

