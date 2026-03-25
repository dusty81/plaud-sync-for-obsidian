# AI Content Markdown Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pass through Plaud's rich AI-generated markdown verbatim instead of decomposing it into flat fields, producing notes that match Plaud's native export quality.

**Architecture:** Add a passthrough path through the existing hydrator → normalizer → renderer pipeline. When the `auto_sum_note` signed URL returns structured markdown (not JSON), store it as `ai_content_markdown` and render it directly with frontmatter and a collapsible transcript. Files without AI content are skipped and retried on next sync.

**Tech Stack:** TypeScript, Node.js native test runner (`node:test` + `node:assert/strict`), esbuild

**Spec:** `docs/superpowers/specs/2026-03-25-ai-content-passthrough-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/plaud-content-hydrator.ts` | Modify | Detect markdown in `auto_sum_note` response, store as `ai_content_markdown`; always fetch signed URL |
| `src/plaud-normalizer.ts` | Modify | Add `aiContentMarkdown` field to `NormalizedPlaudDetail`; extract from detail |
| `src/plaud-renderer.ts` | Modify | Add passthrough rendering path with collapsible `<details>` transcript |
| `src/plaud-sync.ts` | Modify | Skip files without AI content; add `noAiContentSkipped` to checkpoint gate |
| `test/plaud-content-hydrator.test.mjs` | Modify | Add tests for markdown detection and `hasSummary` bypass |
| `test/plaud-normalizer.test.mjs` | Modify | Add tests for `aiContentMarkdown` extraction |
| `test/plaud-renderer.test.mjs` | Modify | Add tests for passthrough template and collapsible transcript |
| `test/plaud-sync.test.mjs` | Modify | Add tests for skip behavior and checkpoint safety |

---

### Task 1: Hydrator — detect markdown and store as `ai_content_markdown`

**Files:**
- Modify: `src/plaud-content-hydrator.ts`
- Test: `test/plaud-content-hydrator.test.mjs`

- [ ] **Step 1: Write failing test — markdown string sets `ai_content_markdown`**

Add to `test/plaud-content-hydrator.test.mjs`:

```javascript
test('stores structured markdown response as ai_content_markdown', async () => {
  const markdownContent = '## Key Points\n- Point one\n- Point two\n\n## Action Items\n| Task | Owner |\n| --- | --- |\n| Do thing | Alice |';
  const detail = {
    file_id: 'f_md',
    content_list: [
      {data_type: 'auto_sum_note', data_link: 'https://example.test/sum'}
    ]
  };

  const hydrated = await hydratePlaudDetailContent(detail, async () => {
    return markdownContent;
  });

  assert.equal(hydrated.ai_content_markdown, markdownContent);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-strip-types --test test/plaud-content-hydrator.test.mjs`
Expected: FAIL — `ai_content_markdown` is `undefined`

- [ ] **Step 3: Write failing test — plain string falls through to existing path**

```javascript
test('plain summary string without markdown structure falls through to existing path', async () => {
  const detail = {
    file_id: 'f_plain',
    content_list: [
      {data_type: 'auto_sum_note', data_link: 'https://example.test/sum'}
    ]
  };

  const hydrated = await hydratePlaudDetailContent(detail, async () => {
    return 'A short summary sentence about the meeting.';
  });

  assert.equal(hydrated.ai_content_markdown, undefined);
  assert.equal(hydrated.summary, 'A short summary sentence about the meeting.');
});
```

- [ ] **Step 4: Remove contradicted existing test and write replacement**

The existing test "does not fetch summary link when summary already exists" (lines 37-54 of `test/plaud-content-hydrator.test.mjs`) asserts the old behavior where the `hasSummary` guard prevented fetching. This test must be **deleted** and replaced with:

```javascript
test('fetches auto_sum_note signed URL even when inline summary already exists', async () => {
  const calls = [];
  const markdownContent = '## Summary\n- Important point\n\n## Decisions\n- Decision one';
  const detail = {
    file_id: 'f_both',
    summary: 'Inline summary already present',
    content_list: [
      {data_type: 'auto_sum_note', data_link: 'https://example.test/sum'}
    ]
  };

  const hydrated = await hydratePlaudDetailContent(detail, async (url) => {
    calls.push(url);
    return markdownContent;
  });

  assert.deepEqual(calls, ['https://example.test/sum']);
  assert.equal(hydrated.ai_content_markdown, markdownContent);
});
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/plaud-content-hydrator.test.mjs`
Expected: 3 new tests FAIL

- [ ] **Step 6: Implement `looksLikeMarkdown` and modify hydration logic**

In `src/plaud-content-hydrator.ts`, add the `looksLikeMarkdown` function and modify `hydratePlaudDetailContent`:

```typescript
function looksLikeMarkdown(text: string): boolean {
	if (/^#{1,6}\s/m.test(text)) {
		return true;
	}

	let indicators = 0;
	if (/^- /m.test(text)) {
		indicators += 1;
	}
	if (/\|.*\|/m.test(text)) {
		indicators += 1;
	}
	if (/^>/m.test(text)) {
		indicators += 1;
	}

	return indicators >= 2;
}
```

Modify `hydratePlaudDetailContent` to:
1. Move the `auto_sum_note` fetch **outside** the `if (!hasSummary(detail))` guard — always fetch when the link exists. Replace the existing summary block (lines 161-171 of `src/plaud-content-hydrator.ts`) which is wrapped in `if (!hasSummary(detail)) { ... }`.
2. After fetching, before calling `applySummaryContent`, check if content is a markdown string:

```typescript
// Replace lines 161-171 (the entire `if (!hasSummary(detail)) { ... }` block):
const summaryLink = pickContentLink(detail, 'auto_sum_note');
if (summaryLink) {
    try {
        const content = await fetchContent(summaryLink);
        if (typeof content === 'string') {
            const trimmed = content.trim();
            if (looksLikeMarkdown(trimmed)) {
                detail.ai_content_markdown = trimmed;
            } else {
                applySummaryContent(detail, content);
            }
        } else {
            applySummaryContent(detail, content);
        }
    } catch {
        // best-effort enrichment only
    }
}
```

- [ ] **Step 7: Run tests to verify all pass**

Run: `node --experimental-strip-types --test test/plaud-content-hydrator.test.mjs`
Expected: ALL PASS (new and existing)

- [ ] **Step 8: Commit**

```bash
git add src/plaud-content-hydrator.ts test/plaud-content-hydrator.test.mjs
git commit -m "feat(hydrator): detect markdown in auto_sum_note and store as ai_content_markdown"
```

---

### Task 2: Normalizer — add `aiContentMarkdown` field

**Files:**
- Modify: `src/plaud-normalizer.ts`
- Test: `test/plaud-normalizer.test.mjs`

- [ ] **Step 1: Write failing test — extracts `aiContentMarkdown` from detail**

Add to `test/plaud-normalizer.test.mjs`:

```javascript
test('extracts aiContentMarkdown from detail when present', () => {
  const normalized = normalizePlaudDetail({
    id: 'ai-md',
    file_id: 'f_ai_md',
    file_name: 'Team standup',
    start_time: 1730000000000,
    duration: 300000,
    ai_content_markdown: '## Key Points\n- Point one\n\n## Action Items\n- Do thing'
  });

  assert.equal(normalized.aiContentMarkdown, '## Key Points\n- Point one\n\n## Action Items\n- Do thing');
  assert.equal(normalized.title, 'Team standup');
});
```

- [ ] **Step 2: Write failing test — `aiContentMarkdown` is empty when not present**

```javascript
test('aiContentMarkdown is empty string when not present in detail', () => {
  const normalized = normalizePlaudDetail({
    id: 'no-ai',
    file_id: 'f_no_ai',
    file_name: 'Old recording'
  });

  assert.equal(normalized.aiContentMarkdown, '');
});
```

- [ ] **Step 3: Write failing test — existing fields still populated alongside `aiContentMarkdown`**

```javascript
test('existing fields are still populated when aiContentMarkdown is present', () => {
  const normalized = normalizePlaudDetail({
    id: 'both',
    file_id: 'f_both',
    file_name: 'Meeting',
    start_time: 1730000000000,
    duration: 600000,
    ai_content_markdown: '## Summary\n- Key point',
    summary: 'Inline summary',
    trans_result: {
      paragraphs: [{speaker: 'A', text: 'Hello'}]
    }
  });

  assert.equal(normalized.aiContentMarkdown, '## Summary\n- Key point');
  assert.equal(normalized.summary, 'Inline summary');
  assert.match(normalized.transcript, /A: Hello/);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/plaud-normalizer.test.mjs`
Expected: 3 new tests FAIL — `aiContentMarkdown` property doesn't exist

- [ ] **Step 5: Add `aiContentMarkdown` to interface and extraction**

In `src/plaud-normalizer.ts`:

Add to `NormalizedPlaudDetail` interface:
```typescript
aiContentMarkdown: string;
```

Add to the return object in `normalizePlaudDetail`:
```typescript
aiContentMarkdown: asString(detail.ai_content_markdown),
```

- [ ] **Step 6: Run tests to verify all pass**

Run: `node --experimental-strip-types --test test/plaud-normalizer.test.mjs`
Expected: ALL PASS (new and existing)

- [ ] **Step 7: Commit**

```bash
git add src/plaud-normalizer.ts test/plaud-normalizer.test.mjs
git commit -m "feat(normalizer): add aiContentMarkdown field to NormalizedPlaudDetail"
```

---

### Task 3: Renderer — passthrough template with collapsible transcript

**Files:**
- Modify: `src/plaud-renderer.ts`
- Test: `test/plaud-renderer.test.mjs`

- [ ] **Step 1: Write failing test — passthrough mode renders AI content with collapsible transcript**

Add to `test/plaud-renderer.test.mjs`:

```javascript
const samplePassthroughDetail = {
  id: 'pt',
  fileId: 'f_pt',
  title: 'Sprint planning',
  startAtMs: 1730678400000,
  durationMs: 1800000,
  summary: '',
  highlights: [],
  transcript: 'Alice: Let us begin\nBob: Sounds good',
  aiContentMarkdown: '## Key Points\n- Sprint goal defined\n\n## Action Items\n- Alice to write spec',
  raw: {}
};

test('passthrough mode renders AI content verbatim with collapsible transcript', () => {
  const markdown = renderPlaudMarkdown(samplePassthroughDetail);

  // Frontmatter present
  assert.match(markdown, /^---/m);
  assert.match(markdown, /^source: plaud$/m);
  assert.match(markdown, /^file_id: f_pt$/m);

  // Title heading
  assert.match(markdown, /^# Sprint planning$/m);

  // AI content passed through verbatim
  assert.match(markdown, /^## Key Points$/m);
  assert.match(markdown, /^- Sprint goal defined$/m);
  assert.match(markdown, /^## Action Items$/m);
  assert.match(markdown, /^- Alice to write spec$/m);

  // Transcript in collapsible section
  assert.match(markdown, /<details>/);
  assert.match(markdown, /<summary>Transcript<\/summary>/);
  assert.match(markdown, /Alice: Let us begin/);
  assert.match(markdown, /Bob: Sounds good/);
  assert.match(markdown, /<\/details>/);

  // Should NOT have the old-style ## Summary or ## Highlights sections
  assert.doesNotMatch(markdown, /## Summary/);
  assert.doesNotMatch(markdown, /## Highlights/);
});
```

- [ ] **Step 2: Write failing test — omits `<details>` when transcript is empty**

```javascript
test('passthrough mode omits details block when transcript is empty', () => {
  const markdown = renderPlaudMarkdown({
    ...samplePassthroughDetail,
    transcript: ''
  });

  assert.match(markdown, /^## Key Points$/m);
  assert.doesNotMatch(markdown, /<details>/);
  assert.doesNotMatch(markdown, /<\/details>/);
});
```

- [ ] **Step 3: Write failing test — falls back to old template when no AI markdown**

```javascript
test('falls back to old template when aiContentMarkdown is empty', () => {
  const markdown = renderPlaudMarkdown({
    ...sampleDetail,
    aiContentMarkdown: ''
  });

  assert.match(markdown, /## Summary/);
  assert.match(markdown, /## Highlights/);
  assert.match(markdown, /## Transcript/);
  assert.doesNotMatch(markdown, /<details>/);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/plaud-renderer.test.mjs`
Expected: New tests FAIL

- [ ] **Step 5: Implement passthrough rendering**

In `src/plaud-renderer.ts`, modify `renderPlaudMarkdown`:

```typescript
export function renderPlaudMarkdown(detail: NormalizedPlaudDetail): string {
	const title = normalizeTitle(detail.title);
	const date = formatDate(detail.startAtMs);
	const duration = formatDuration(detail.durationMs);

	const frontmatter = [
		'---',
		'source: plaud',
		'type: recording',
		`file_id: ${detail.fileId}`,
		`title: "${escapeFrontmatterValue(title)}"`,
		`date: ${date}`,
		`duration: ${duration}`,
		'---'
	].join('\n');

	if (detail.aiContentMarkdown) {
		const parts = [frontmatter, '', `# ${title}`, '', detail.aiContentMarkdown];

		const transcript = detail.transcript.trim();
		if (transcript) {
			parts.push('', '<details>', '<summary>Transcript</summary>', '', transcript, '', '</details>');
		}

		parts.push('');
		return parts.join('\n');
	}

	const summary = detail.summary.trim() || 'No summary available.';
	const transcript = detail.transcript.trim() || 'No transcript available.';

	return [
		frontmatter,
		'',
		`# ${title}`,
		'',
		'## Summary',
		summary,
		'',
		'## Highlights',
		renderHighlights(detail.highlights),
		'',
		'## Transcript',
		transcript,
		''
	].join('\n');
}
```

- [ ] **Step 6: Update `sampleDetail` to include `aiContentMarkdown`**

The existing `sampleDetail` in the test file needs `aiContentMarkdown: ''` added so existing tests keep working with the updated `NormalizedPlaudDetail` shape:

```javascript
const sampleDetail = {
  id: 'abc',
  fileId: 'f_abc',
  title: 'Weekly sync',
  startAtMs: 1730678400000,
  durationMs: 1800000,
  summary: 'Summary text',
  highlights: ['Highlight one', 'Highlight two'],
  transcript: 'Speaker A: Hello',
  aiContentMarkdown: '',
  raw: {}
};
```

- [ ] **Step 7: Run tests to verify all pass**

Run: `node --experimental-strip-types --test test/plaud-renderer.test.mjs`
Expected: ALL PASS (new and existing)

- [ ] **Step 8: Commit**

```bash
git add src/plaud-renderer.ts test/plaud-renderer.test.mjs
git commit -m "feat(renderer): add passthrough mode with collapsible transcript"
```

---

### Task 4: Sync loop — skip files without AI content, protect checkpoint

**Files:**
- Modify: `src/plaud-sync.ts`
- Test: `test/plaud-sync.test.mjs`

- [ ] **Step 1: Write failing test — files without AI content are skipped**

Add to `test/plaud-sync.test.mjs`:

```javascript
test('skips files where aiContentMarkdown is empty after normalization', async () => {
  const upsertCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          {id: 'has_ai', start_time: 200, is_trash: false},
          {id: 'no_ai', start_time: 300, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        return {id, file_id: id, file_name: id, start_time: id === 'has_ai' ? 200 : 300, duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 100}),
    saveCheckpoint: async () => {},
    normalizeDetail: (raw) => ({
      id: raw.id,
      fileId: raw.file_id,
      title: raw.file_name,
      startAtMs: raw.start_time,
      durationMs: raw.duration,
      summary: '',
      highlights: [],
      transcript: '',
      aiContentMarkdown: raw.id === 'has_ai' ? '## Summary\n- Point' : '',
      raw
    }),
    renderMarkdown: () => '---\nfile_id: x\n---',
    upsertNote: async (input) => {
      upsertCalls.push(input.fileId);
      return {action: 'created', path: `Plaud/${input.fileId}.md`};
    }
  });

  assert.deepEqual(upsertCalls, ['has_ai']);
  assert.equal(summary.created, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
});
```

- [ ] **Step 2: Write failing test — checkpoint does not advance when files were skipped for missing AI content**

```javascript
test('checkpoint does not advance when any file was skipped for missing AI content', async () => {
  const checkpointCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          {id: 'a', start_time: 200, is_trash: false},
          {id: 'b_no_ai', start_time: 300, is_trash: false},
          {id: 'c', start_time: 400, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        return {id, file_id: id, file_name: id, start_time: ({a: 200, b_no_ai: 300, c: 400})[id], duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 100}),
    saveCheckpoint: async (value) => {
      checkpointCalls.push(value);
    },
    normalizeDetail: (raw) => ({
      id: raw.id,
      fileId: raw.file_id,
      title: raw.file_name,
      startAtMs: raw.start_time,
      durationMs: raw.duration,
      summary: '',
      highlights: [],
      transcript: '',
      aiContentMarkdown: raw.id === 'b_no_ai' ? '' : '## Content\n- Data',
      raw
    }),
    renderMarkdown: () => '---\nfile_id: x\n---',
    upsertNote: async () => ({action: 'created', path: 'Plaud/x.md'})
  });

  assert.equal(summary.created, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(checkpointCalls, []);
  assert.equal(summary.lastSyncAtMsAfter, 100);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --experimental-strip-types --test test/plaud-sync.test.mjs`
Expected: New tests FAIL

- [ ] **Step 4: Implement skip logic and checkpoint protection**

In `src/plaud-sync.ts`, modify `runPlaudSync`:

1. Add a `noAiContentSkipped` counter initialized to `0`
2. After `const normalized = input.normalizeDetail(detail);`, add:

```typescript
if (!normalized.aiContentMarkdown) {
    skipped += 1;
    noAiContentSkipped += 1;
    continue;
}
```

3. Change the checkpoint gate from:
```typescript
if (failed === 0 && checkpointCandidate > checkpointBefore) {
```
to:
```typescript
if (failed === 0 && noAiContentSkipped === 0 && checkpointCandidate > checkpointBefore) {
```

- [ ] **Step 5: Update existing test `normalizeDetail` mocks to include `aiContentMarkdown`**

All three existing tests have `normalizeDetail` mocks returning objects without `aiContentMarkdown`. Without this field, the new skip logic will skip every file, breaking all assertions. Add `aiContentMarkdown: '## Content'` to the return object of each mock:

1. **Test "filters trashed recordings..."** (line 44-53): add `aiContentMarkdown: '## Content'` to the return object. This test expects `created: 1`.
2. **Test "returns created/updated/skipped/failed..."** (line 95-104): add `aiContentMarkdown: '## Content'` to the return object. This test expects `created: 1, updated: 1, skipped: 1, failed: 1`.
3. **Test "advances lastSyncAtMs..."** (line 149-158): add `aiContentMarkdown: '## Content'` to the return object. This test expects two files processed and checkpoint at 1500.

- [ ] **Step 6: Run tests to verify all pass**

Run: `node --experimental-strip-types --test test/plaud-sync.test.mjs`
Expected: ALL PASS (new and existing)

- [ ] **Step 7: Commit**

```bash
git add src/plaud-sync.ts test/plaud-sync.test.mjs
git commit -m "feat(sync): skip files without AI content, protect checkpoint advancement"
```

---

### Task 5: Full integration test and build verification

**Files:**
- All modified source files
- All modified test files

- [ ] **Step 1: Run full test suite**

Run: `node --experimental-strip-types --test test/*.test.mjs`
Expected: ALL PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 3: Run production build**

Run: `npm run build`
Expected: Successful build, `main.js` updated

- [ ] **Step 4: Commit build artifact if changed**

```bash
git add main.js
git commit -m "build: rebuild main.js with AI content passthrough"
```
