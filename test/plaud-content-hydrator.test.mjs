import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/plaud-content-hydrator.ts')).href;
const {hydratePlaudDetailContent} = await import(moduleUrl);

test('hydrates summary and transcript from content_list signed links', async () => {
  const calls = [];
  const detail = {
    file_id: 'f_1',
    content_list: [
      {data_type: 'auto_sum_note', data_link: 'https://example.test/sum'},
      {data_type: 'transaction', data_link: 'https://example.test/trans'}
    ]
  };

  const hydrated = await hydratePlaudDetailContent(detail, async (url) => {
    calls.push(url);
    if (url.endsWith('/sum')) {
      return {ai_content: 'Summary from signed content'};
    }
    return [
      {speaker: 'Speaker 1', content: 'Hello world'}
    ];
  });

  assert.deepEqual(calls, ['https://example.test/sum', 'https://example.test/trans']);
  assert.equal(hydrated.summary, 'Summary from signed content');
  assert.ok(Array.isArray(hydrated.transcript));
  assert.equal(hydrated.transcript.length, 1);
});

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

test('parses transcript payload when content URL returns JSON string', async () => {
  const detail = {
    file_id: 'f_3',
    content_list: [
      {data_type: 'transaction', data_link: 'https://example.test/trans'}
    ]
  };

  const hydrated = await hydratePlaudDetailContent(detail, async () => {
    return JSON.stringify([{speaker: 'S', content: 'Line'}]);
  });

  assert.ok(Array.isArray(hydrated.transcript));
  assert.equal(hydrated.transcript[0].content, 'Line');
});
