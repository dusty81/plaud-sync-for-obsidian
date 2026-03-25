# AI Content Markdown Passthrough

## Problem

The Plaud API returns rich, structured markdown from the `auto_sum_note` signed URL (`ai_content.md.gz`). This content includes context-aware sections (executive summary, action items with tables, decisions, key quotes, timelines, risks, etc.) that match the quality of Plaud's manual .md export.

The current plugin pipeline loses this structure:
1. The hydrator tries to extract a single `summary` string from the markdown
2. The normalizer decomposes it further into flat `summary` / `highlights` / `transcript` fields
3. `stripMarkup` removes HTML/markdown formatting in the `pre_download_content_list` code path (note: the primary `extractSummary` path does not strip, but the flat template still loses structure)
4. The renderer wraps those flat fields in a rigid 4-section template

The result is a poor-quality note that loses the rich sectioned structure Plaud already generated.

## Solution

Pass the AI content markdown through verbatim instead of decomposing it. Files without AI content are skipped (synced on a future run when processing completes).

## Approach

Modify the existing pipeline (hydrator, normalizer, renderer, sync loop) with a passthrough path. The decomposition logic remains as-is for backward compatibility but is bypassed when rich markdown is available.

## Detailed Design

### Hydrator (`plaud-content-hydrator.ts`)

When fetching the `auto_sum_note` signed URL, the response may be:
- A **plain string** (the full markdown document) -- this is the common case observed in the API
- A **JSON object** with fields like `ai_content`, `summary`, etc.

Current behavior: `applySummaryContent` calls `parseMaybeJson` on string content. If the string is not valid JSON, it stores it as `detail.summary`. If it is valid JSON, it extracts fields from the parsed object.

New behavior: **always fetch the `auto_sum_note` signed URL when it exists in `content_list`**, regardless of whether `hasSummary(detail)` is true (the current guard skips the fetch if an inline summary exists, which would prevent the passthrough from ever triggering if Plaud starts including both). After fetching, if the content is a string that looks like structured markdown, store it directly on the detail record as `ai_content_markdown`. The existing `applySummaryContent` logic remains for the JSON object case.

```typescript
// In the summary hydration block, after fetching content:
if (typeof content === 'string') {
    const trimmed = content.trim();
    if (looksLikeMarkdown(trimmed)) {
        detail.ai_content_markdown = trimmed;
        return;  // skip decomposition
    }
}
// ...existing applySummaryContent logic as fallback
```

`looksLikeMarkdown`: returns true if the string contains at least one markdown heading (`#` at start of line) or at least two structural indicators (list items `- `, table pipes `|`, blockquotes `>`). The heuristic is intentionally generous -- false positives (passing through a non-markdown string) are less harmful than false negatives (falling back to the flat template), since the fallback is the lower-quality rendering we're trying to avoid.

Note: gzip decompression of `ai_content.md.gz` is handled transparently by the HTTP layer (Obsidian's `requestUrl` / S3 content-encoding). No decompression logic is needed in the hydrator.

### Normalizer (`plaud-normalizer.ts`)

Add `aiContentMarkdown: string` to `NormalizedPlaudDetail`.

```typescript
export interface NormalizedPlaudDetail {
    // ...existing fields...
    aiContentMarkdown: string;
}
```

In `normalizePlaudDetail`, extract `detail.ai_content_markdown` as a string. All existing extraction logic (summary, highlights, transcript) continues to run regardless -- it populates fallback fields that may be useful for frontmatter or other purposes.

### Renderer (`plaud-renderer.ts`)

When `aiContentMarkdown` is non-empty, use a passthrough template:

```markdown
---
source: plaud
type: recording
file_id: {fileId}
title: "{title}"
date: {YYYY-MM-DD}
duration: {X min}
---

# {title}

{aiContentMarkdown -- verbatim, no modifications}

<details>
<summary>Transcript</summary>

{transcript -- Speaker: text format, one line per speaker turn}

</details>
```

When `aiContentMarkdown` is empty, the existing template is used (frontmatter + Summary + Highlights + Transcript sections).

The collapsible transcript uses HTML `<details>/<summary>` tags, which Obsidian renders natively.

### Sync Loop (`plaud-sync.ts`)

After normalization, check `normalized.aiContentMarkdown`. If it is empty, skip the file:
- Increment `skipped` counter (not `failed`)
- Do not advance the checkpoint past this file

**Checkpoint safety:** The existing checkpoint gate is `if (failed === 0 && checkpointCandidate > checkpointBefore)`. Skipped files don't increment `failed` and don't contribute to `checkpointCandidate`. But if a later file succeeds, its `start_time` pushes `checkpointCandidate` past the skipped file's timestamp, permanently skipping it on future syncs.

Fix: change the checkpoint gate to `if (failed === 0 && noAiContentSkipped === 0 && checkpointCandidate > checkpointBefore)`. Track a separate `noAiContentSkipped` counter. If any file was skipped due to missing AI content, the checkpoint does not advance at all -- ensuring those files are re-selected next sync. This is conservative but correct; once AI content becomes available, the next sync processes everything and advances the checkpoint normally.

Implementation: after normalization, if `aiContentMarkdown` is empty, increment `noAiContentSkipped` and `continue` (skip the upsert). Do not update `checkpointCandidate`.

### Transcript Formatting

The transcript is rendered inside the collapsible section using the existing `normalizeTranscriptLine` format: `Speaker: text`, one line per turn. If no transcript is available, the `<details>` block is omitted entirely.

## Files Modified

| File | Change |
|------|--------|
| `src/plaud-content-hydrator.ts` | Detect markdown string response, store as `ai_content_markdown` |
| `src/plaud-normalizer.ts` | Add `aiContentMarkdown` field to interface and extraction |
| `src/plaud-renderer.ts` | Add passthrough rendering path with collapsible transcript |
| `src/plaud-sync.ts` | Skip files without AI content (don't advance checkpoint past them) |

## Files NOT Modified

- `src/plaud-api.ts` / `src/plaud-api-obsidian.ts` -- no API changes needed
- `src/plaud-retry.ts` -- retry logic unchanged
- `src/plaud-vault.ts` -- upsert logic unchanged
- `src/secret-store.ts` -- token handling unchanged
- `src/settings.ts` / `src/settings-schema.ts` -- no new settings
- `src/main.ts` -- orchestration unchanged
- `src/commands.ts` -- commands unchanged
- `src/sync-runtime.ts` -- concurrency guard unchanged

## New Tests

| Test file | Cases |
|-----------|-------|
| `test/plaud-content-hydrator.test.mjs` | String markdown response sets `ai_content_markdown`; JSON object response still uses existing `applySummaryContent` path; string that fails `looksLikeMarkdown` falls through to existing path; always fetches signed URL even when inline summary exists |
| `test/plaud-normalizer.test.mjs` | `aiContentMarkdown` extracted from detail; empty when not present; existing fields (`summary`, `highlights`, `transcript`) still populated when `aiContentMarkdown` is present |
| `test/plaud-renderer.test.mjs` | Passthrough mode: produces frontmatter + title + AI markdown + collapsible transcript; omits `<details>` when no transcript; falls back to old template when no AI markdown |
| `test/plaud-sync.test.mjs` | Files without AI content are skipped (counted as skipped, not failed); checkpoint does NOT advance when any file was skipped for missing AI content; file A succeeds, file B skipped (no AI content), file C succeeds -- checkpoint stays at previous value; skipped files re-selected on next sync |

## Backward Compatibility

Existing synced notes will be updated on next sync if `updateExisting: true` (the default). The new passthrough format replaces the old flat template. This is the desired behavior -- the whole point is to improve note quality. Users who want to preserve old notes can set `updateExisting: false`.

## Output Example

For a recording titled "03-17 Meeting: Cortex XDR RBAC", the synced note would look like:

```markdown
---
source: plaud
type: recording
file_id: da699e5f6107b0c3336792a6e7c43a61
title: "03-17 Meeting: Cortex XDR Role-Based Access Controls (RBAC)"
date: 2026-03-17
duration: 45 min
---

# 03-17 Meeting: Cortex XDR Role-Based Access Controls (RBAC)

## Key Points & Status
- Purpose: Define role-based access controls (RBAC) for Cortex XDR...
  ...

## Action Items
| Task | Assigned To | Deadline | Notes |
| --- | --- | --- | --- |
| Configure SAML role assignments... | Grant Mortenson | 2026-04-17 | ... |
  ...

## Decisions Made
- InfoSec owns Cortex XDR...
  ...

<details>
<summary>Transcript</summary>

Grant Mortenson: My proposal is in a nutshell...
Dustin Schnabel: Our intention then is...
Grant Mortenson: Those typical sort of incident response tasks...

</details>
```
