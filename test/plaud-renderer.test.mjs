import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/plaud-renderer.ts')).href;
const {renderPlaudMarkdown} = await import(moduleUrl);

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

test('renders frontmatter contract fields', () => {
  const markdown = renderPlaudMarkdown(sampleDetail);

  assert.match(markdown, /^---/m);
  assert.match(markdown, /^source: plaud$/m);
  assert.match(markdown, /^type: recording$/m);
  assert.match(markdown, /^file_id: f_abc$/m);
  assert.match(markdown, /^title: "Weekly sync"$/m);
  assert.match(markdown, /^date: 2024-11-04$/m);
  assert.match(markdown, /^duration: 30 min$/m);
});

test('renders required body sections in order', () => {
  const markdown = renderPlaudMarkdown(sampleDetail);

  const summaryIndex = markdown.indexOf('## Summary');
  const highlightsIndex = markdown.indexOf('## Highlights');
  const transcriptIndex = markdown.indexOf('## Transcript');

  assert.ok(summaryIndex > 0);
  assert.ok(highlightsIndex > summaryIndex);
  assert.ok(transcriptIndex > highlightsIndex);

  assert.match(markdown, /Summary text/);
  assert.match(markdown, /- Highlight one/);
  assert.match(markdown, /Speaker A: Hello/);
});

test('rendering is deterministic for identical input', () => {
  const first = renderPlaudMarkdown(sampleDetail);
  const second = renderPlaudMarkdown(sampleDetail);

  assert.equal(first, second);
});

test('gracefully renders placeholders for missing optional fields', () => {
  const markdown = renderPlaudMarkdown({
    id: 'x',
    fileId: 'x',
    title: '',
    startAtMs: 0,
    durationMs: 0,
    summary: '',
    highlights: [],
    transcript: '',
    raw: {}
  });

  assert.match(markdown, /# Untitled recording/);
  assert.match(markdown, /No summary available\./);
  assert.match(markdown, /- No highlights extracted\./);
  assert.match(markdown, /No transcript available\./);
});

test('escapes quotes in title frontmatter while preserving heading text', () => {
  const markdown = renderPlaudMarkdown({
    ...sampleDetail,
    title: 'Exec "Q4" Sync'
  });

  assert.match(markdown, /^title: "Exec \\"Q4\\" Sync"$/m);
  assert.match(markdown, /^# Exec "Q4" Sync$/m);
});

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

  // Transcript in collapsible callout
  assert.match(markdown, /> \[!note\]- Transcript/);
  assert.match(markdown, /> Alice: Let us begin/);
  assert.match(markdown, /> Bob: Sounds good/);

  // Should NOT have the old-style ## Summary or ## Highlights sections
  assert.doesNotMatch(markdown, /## Summary/);
  assert.doesNotMatch(markdown, /## Highlights/);
});

test('passthrough mode omits callout when transcript is empty', () => {
  const markdown = renderPlaudMarkdown({
    ...samplePassthroughDetail,
    transcript: ''
  });

  assert.match(markdown, /^## Key Points$/m);
  assert.doesNotMatch(markdown, /\[!note\]- Transcript/);
});

test('passthrough mode adds blank lines around tables for Obsidian rendering', () => {
  const markdown = renderPlaudMarkdown({
    ...samplePassthroughDetail,
    aiContentMarkdown: '🎯 **Action Items**\n| Task | Owner |\n| --- | --- |\n| Write spec | Alice |\n⚖️ **Decisions**'
  });

  const lines = markdown.split('\n');
  const tableStart = lines.findIndex((l) => l.startsWith('| Task'));
  const tableEnd = lines.findIndex((l) => l.startsWith('| Write'));

  // Blank line before table header
  assert.equal(lines[tableStart - 1], '');
  // Blank line after last table row
  assert.equal(lines[tableEnd + 1], '');
});

test('extracts pseudo-headers from table rows with empty cells', () => {
  const markdown = renderPlaudMarkdown({
    ...samplePassthroughDetail,
    aiContentMarkdown: '🎯 **Action Items**\n| Task | Owner |\n| --- | --- |\n| Write spec | Alice |\n| ⚖️ **Decisions Made** |  |  |  |\n- We decided X'
  });

  // The pseudo-header row should be extracted as plain text, not a table row
  assert.ok(markdown.includes('⚖️ **Decisions Made**'));
  assert.ok(!markdown.includes('| ⚖️ **Decisions Made**'));
  // The actual table should still be there
  assert.ok(markdown.includes('| Write spec | Alice |'));
});

test('falls back to old template when aiContentMarkdown is empty', () => {
  const markdown = renderPlaudMarkdown({
    ...sampleDetail,
    aiContentMarkdown: ''
  });

  assert.match(markdown, /## Summary/);
  assert.match(markdown, /## Highlights/);
  assert.match(markdown, /## Transcript/);
  assert.doesNotMatch(markdown, /\[!note\]- Transcript/);
});
