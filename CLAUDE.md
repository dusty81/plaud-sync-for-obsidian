# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin that syncs voice recordings from Plaud.ai into Markdown notes with transcripts, AI summaries, and highlights. Uses a reverse-engineered (unofficial) Plaud API — the token is a JWT extracted from `localStorage.getItem("tokenstr")` on web.plaud.ai.

## Commands

- **Build:** `npm run build` (runs `tsc -noEmit -skipLibCheck` then esbuild production bundle → `main.js`)
- **Dev:** `npm run dev` (esbuild watch mode)
- **Lint:** `npm run lint`
- **Test all:** `npm run test`
- **Test single file:** `node --experimental-strip-types --test test/<name>.test.mjs`

Tests use the Node.js native test runner (`node:test` + `node:assert`), not Jest or Vitest.

## Architecture

### Sync Pipeline (data flows top-to-bottom)

```
main.ts (PlaudSyncPlugin)
  ↓ orchestrates full lifecycle, creates vault adapter & resilient API client
plaud-api.ts / plaud-api-obsidian.ts
  ↓ HTTP client (interface + Obsidian requestUrl adapter)
plaud-retry.ts
  ↓ exponential backoff wrapper for transient errors
plaud-content-hydrator.ts
  ↓ fetches transcript/summary from signed URLs when missing from detail
plaud-normalizer.ts
  ↓ extracts title/summary/highlights/transcript from multiple API response shapes
plaud-renderer.ts
  ↓ renders NormalizedPlaudDetail → YAML frontmatter + Markdown
plaud-vault.ts
  ↓ idempotent upsert: matches existing notes by file_id in frontmatter
```

### Key Design Patterns

- **Dependency injection everywhere.** All business logic takes interfaces (`PlaudApiClient`, `PlaudVaultAdapter`), not Obsidian classes. This is what makes the test suite work with plain mocks.
- **Single-flight guard** (`sync-runtime.ts`): prevents concurrent syncs via in-flight Promise tracking.
- **Checkpoint semantics:** `lastSyncAtMs` only advances when ALL files in a batch succeed — partial failures don't move the watermark.
- **Envelope normalization** (`plaud-api.ts`): the Plaud API returns varying response shapes (`payload`, `data`, `data_file_list`, bare array). The client handles all variants.
- **Idempotent upsert** (`plaud-vault.ts`): uses `file_id` in YAML frontmatter as the stable identity key. Filename collisions get `-2`, `-3` suffixes.

### Token Storage

Tokens are stored via Obsidian's Secret Storage API with a localStorage fallback (`secret-store.ts`). They are never persisted in plugin settings or logged.

### Plaud API Endpoints

- `GET /file/simple/web` — list all recordings
- `GET /file/detail/{fileId}` — get full recording detail (may include signed URLs for content)

Error categories: `auth` (401/403), `rate_limit` (429), `server` (5xx), `network` (other 4xx), `invalid_response` (malformed payload).
