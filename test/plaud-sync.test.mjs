import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/plaud-sync.ts')).href;
const {runPlaudSync} = await import(moduleUrl);

function baseSettings(overrides = {}) {
  return {
    syncFolder: 'Plaud',
    filenamePattern: 'plaud-{date}-{title}',
    expandTitleDate: false,
    updateExisting: true,
    lastSyncAtMs: 0,
    ...overrides
  };
}

test('filters trashed recordings and applies incremental selection from lastSyncAtMs', async () => {
  const detailCalls = [];
  const checkpointCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          {id: 'old', start_time: 1700000000000, is_trash: false},
          {id: 'trash', start_time: 1700000500000, is_trash: true},
          {id: 'keep', start_time: 1700000200000, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        detailCalls.push(id);
        return {id, file_id: id, file_name: id, start_time: id === 'keep' ? 1700000200000 : 1700000000000, duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 1700000100000}),
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
      aiContentMarkdown: '## Content',
      raw
    }),
    renderMarkdown: () => '---\nfile_id: keep\n---',
    upsertNote: async () => ({action: 'created', path: 'Plaud/keep.md'}),
    fetchBinary: async () => new ArrayBuffer(0),
    buildSignedUrlMap: () => [],
    resolveImages: async (input) => ({markdown: input.markdown, downloaded: 0})
  });

  assert.deepEqual(detailCalls, ['keep']);
  assert.equal(summary.created, 1);
  assert.equal(summary.updated, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.selected, 1);
  assert.deepEqual(checkpointCalls, [1700000200000]);
  assert.equal(summary.lastSyncAtMsAfter, 1700000200000);
});

test('returns created/updated/skipped/failed summary counts and does not checkpoint on failures', async () => {
  const checkpointCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          {id: 'create', start_time: 1700000101000, is_trash: false},
          {id: 'update', start_time: 1700000102000, is_trash: false},
          {id: 'skip', start_time: 1700000103000, is_trash: false},
          {id: 'fail', start_time: 1700000104000, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        if (id === 'fail') {
          throw new Error('detail failed');
        }

        return {id, file_id: id, file_name: id, start_time: 1700000100000 + id.length * 1000, duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 1700000100000}),
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
      aiContentMarkdown: '## Content',
      raw
    }),
    renderMarkdown: () => '---\nfile_id: x\n---',
    upsertNote: async (input) => {
      if (input.fileId === 'create') {
        return {action: 'created', path: 'Plaud/create.md'};
      }
      if (input.fileId === 'update') {
        return {action: 'updated', path: 'Plaud/update.md'};
      }
      return {action: 'skipped', path: 'Plaud/skip.md'};
    },
    fetchBinary: async () => new ArrayBuffer(0),
    buildSignedUrlMap: () => [],
    resolveImages: async (input) => ({markdown: input.markdown, downloaded: 0})
  });

  assert.equal(summary.created, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.lastSyncAtMsAfter, 1700000100000);
  assert.deepEqual(checkpointCalls, []);
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].fileId, 'fail');
  assert.match(summary.failures[0].message, /detail failed/);
});

test('advances lastSyncAtMs only after successful batch completion', async () => {
  const checkpointCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          {id: 'a', start_time: 1700000001000, is_trash: false},
          {id: 'b', start_time: 1700000001500, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        return {id, file_id: id, file_name: id, start_time: id === 'a' ? 1700000001000 : 1700000001500, duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 1700000000500}),
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
      aiContentMarkdown: '## Content',
      raw
    }),
    renderMarkdown: () => '---\nfile_id: x\n---',
    upsertNote: async (input) => ({action: input.fileId === 'a' ? 'updated' : 'created', path: 'Plaud/x.md'}),
    fetchBinary: async () => new ArrayBuffer(0),
    buildSignedUrlMap: () => [],
    resolveImages: async (input) => ({markdown: input.markdown, downloaded: 0})
  });

  assert.equal(summary.failed, 0);
  assert.deepEqual(checkpointCalls, [1700000001500]);
  assert.equal(summary.lastSyncAtMsAfter, 1700000001500);
});

test('skips files where aiContentMarkdown is empty after normalization', async () => {
  const upsertCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          {id: 'has_ai', start_time: 1700000200000, is_trash: false},
          {id: 'no_ai', start_time: 1700000300000, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        return {id, file_id: id, file_name: id, start_time: id === 'has_ai' ? 1700000200000 : 1700000300000, duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 1700000100000}),
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
    },
    fetchBinary: async () => new ArrayBuffer(0),
    buildSignedUrlMap: () => [],
    resolveImages: async (input) => ({markdown: input.markdown, downloaded: 0})
  });

  assert.deepEqual(upsertCalls, ['has_ai']);
  assert.equal(summary.created, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
});

test('checkpoint advances past files skipped for missing AI content', async () => {
  const checkpointCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          {id: 'a', start_time: 1700000200000, is_trash: false},
          {id: 'b_no_ai', start_time: 1700000300000, is_trash: false},
          {id: 'c', start_time: 1700000400000, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        return {id, file_id: id, file_name: id, start_time: ({a: 1700000200000, b_no_ai: 1700000300000, c: 1700000400000})[id], duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 1700000100000}),
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
    upsertNote: async () => ({action: 'created', path: 'Plaud/x.md'}),
    fetchBinary: async () => new ArrayBuffer(0),
    buildSignedUrlMap: () => [],
    resolveImages: async (input) => ({markdown: input.markdown, downloaded: 0})
  });

  assert.equal(summary.created, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 0);
  assert.deepEqual(checkpointCalls, [1700000400000]);
  assert.equal(summary.lastSyncAtMsAfter, 1700000400000);
});

test('edit_time in seconds triggers re-sync for updated recordings', async () => {
  const detailCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          // start_time is old but edit_time (in seconds) is recent
          {id: 'edited', start_time: 1700000000000, edit_time: 1700000500, is_trash: false},
          {id: 'old', start_time: 1700000000000, edit_time: 1700000050, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        detailCalls.push(id);
        return {id, file_id: id, file_name: id, start_time: 1700000000000, duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 1700000100000}),
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
      aiContentMarkdown: '## Content',
      raw
    }),
    renderMarkdown: () => '---\nfile_id: x\n---',
    upsertNote: async () => ({action: 'updated', path: 'Plaud/x.md'}),
    fetchBinary: async () => new ArrayBuffer(0),
    buildSignedUrlMap: () => [],
    resolveImages: async (input) => ({markdown: input.markdown, downloaded: 0})
  });

  // edit_time 1700000500 * 1000 = 1700000500000 > checkpoint 1700000100000
  // edit_time 1700000050 * 1000 = 1700000050000 < checkpoint 1700000100000
  assert.deepEqual(detailCalls, ['edited']);
  assert.equal(summary.selected, 1);
  assert.equal(summary.updated, 1);
});
