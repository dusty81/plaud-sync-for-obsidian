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
          {id: 'old', start_time: 10, is_trash: false},
          {id: 'trash', start_time: 500, is_trash: true},
          {id: 'keep', start_time: 200, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        detailCalls.push(id);
        return {id, file_id: id, file_name: id, start_time: id === 'keep' ? 200 : 10, duration: 60000};
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
      aiContentMarkdown: '## Content',
      raw
    }),
    renderMarkdown: () => '---\nfile_id: keep\n---',
    upsertNote: async () => ({action: 'created', path: 'Plaud/keep.md'})
  });

  assert.deepEqual(detailCalls, ['keep']);
  assert.equal(summary.created, 1);
  assert.equal(summary.updated, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.selected, 1);
  assert.deepEqual(checkpointCalls, [200]);
  assert.equal(summary.lastSyncAtMsAfter, 200);
});

test('returns created/updated/skipped/failed summary counts and does not checkpoint on failures', async () => {
  const checkpointCalls = [];

  const summary = await runPlaudSync({
    api: {
      async listFiles() {
        return [
          {id: 'create', start_time: 101, is_trash: false},
          {id: 'update', start_time: 102, is_trash: false},
          {id: 'skip', start_time: 103, is_trash: false},
          {id: 'fail', start_time: 104, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        if (id === 'fail') {
          throw new Error('detail failed');
        }

        return {id, file_id: id, file_name: id, start_time: 100 + id.length, duration: 60000};
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
    }
  });

  assert.equal(summary.created, 1);
  assert.equal(summary.updated, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.lastSyncAtMsAfter, 100);
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
          {id: 'a', start_time: 1000, is_trash: false},
          {id: 'b', start_time: 1500, is_trash: false}
        ];
      },
      async getFileDetail(id) {
        return {id, file_id: id, file_name: id, start_time: id === 'a' ? 1000 : 1500, duration: 60000};
      }
    },
    vault: {},
    settings: baseSettings({lastSyncAtMs: 500}),
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
    upsertNote: async (input) => ({action: input.fileId === 'a' ? 'updated' : 'created', path: 'Plaud/x.md'})
  });

  assert.equal(summary.failed, 0);
  assert.deepEqual(checkpointCalls, [1500]);
  assert.equal(summary.lastSyncAtMsAfter, 1500);
});

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
