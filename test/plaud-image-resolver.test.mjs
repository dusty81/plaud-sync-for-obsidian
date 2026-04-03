import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/plaud-image-resolver.ts')).href;
const {extractImageRefs, buildSignedUrlMap, resolveImages} = await import(moduleUrl);

test('extractImageRefs finds image references in markdown', () => {
  const md = `## Summary
![card](permanent/abc123/summary_poster/card_001.png)
Some text
![](permanent/abc123/summary_poster/card_002.jpg)
`;
  const refs = extractImageRefs(md);
  assert.deepEqual(refs, [
    'permanent/abc123/summary_poster/card_001.png',
    'permanent/abc123/summary_poster/card_002.jpg'
  ]);
});

test('extractImageRefs returns empty for markdown without images', () => {
  const refs = extractImageRefs('## Summary\n- Point one\n- Point two');
  assert.deepEqual(refs, []);
});

test('buildSignedUrlMap extracts image URLs from raw detail', () => {
  const rawDetail = {
    id: 'abc',
    content_list: [
      {data_type: 'auto_sum_note', data_link: 'https://s3.example.com/summary.md.gz'},
      {data_type: 'summary_poster', data_link: 'https://s3.example.com/permanent/abc/poster/card.png?X-Amz-Signature=xyz'},
      {data_type: 'transaction', data_link: 'https://s3.example.com/transcript.json'}
    ]
  };

  const urls = buildSignedUrlMap(rawDetail);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].relativePath, 'permanent/abc/poster/card.png');
  assert.equal(urls[0].signedUrl, 'https://s3.example.com/permanent/abc/poster/card.png?X-Amz-Signature=xyz');
});

test('buildSignedUrlMap finds image URLs in nested fields', () => {
  const rawDetail = {
    id: 'abc',
    poster_url: 'https://s3.example.com/permanent/abc/poster/card.png?sig=xyz',
    nested: {
      deep: {
        image: 'https://s3.example.com/permanent/abc/other.jpg?sig=abc'
      }
    }
  };

  const urls = buildSignedUrlMap(rawDetail);
  assert.equal(urls.length, 2);
});

test('buildSignedUrlMap decodes URL-encoded paths', () => {
  const rawDetail = {
    url: 'https://s3.example.com/permanent/abc/card%40tag.png?sig=x'
  };

  const urls = buildSignedUrlMap(rawDetail);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].relativePath, 'permanent/abc/card@tag.png');
});

test('resolveImages downloads and rewrites image references', async () => {
  const createdFiles = new Map();
  const foldersCreated = [];

  const vault = {
    async ensureFolder(path) { foldersCreated.push(path); },
    async listMarkdownFiles() { return []; },
    async read() { return ''; },
    async write() {},
    async create() {},
    async createBinary(path, data) { createdFiles.set(path, data); }
  };

  const md = '## Summary\n![](permanent/abc/poster/card_001.png)\nText\n![](permanent/abc/poster/card_002.png)';
  const imageUrls = [
    {relativePath: 'permanent/abc/poster/card_001.png', signedUrl: 'https://s3.example.com/permanent/abc/poster/card_001.png?sig=a'},
    {relativePath: 'permanent/abc/poster/card_002.png', signedUrl: 'https://s3.example.com/permanent/abc/poster/card_002.png?sig=b'}
  ];

  const fakeData = new ArrayBuffer(8);

  const result = await resolveImages({
    vault,
    syncFolder: 'Plaud',
    markdown: md,
    imageUrls,
    fetchBinary: async () => fakeData
  });

  assert.equal(result.downloaded, 2);
  assert.ok(result.markdown.includes('![](assets/card_001.png)'));
  assert.ok(result.markdown.includes('![](assets/card_002.png)'));
  assert.ok(!result.markdown.includes('permanent/'));
  assert.ok(createdFiles.has('Plaud/assets/card_001.png'));
  assert.ok(createdFiles.has('Plaud/assets/card_002.png'));
  assert.deepEqual(foldersCreated, ['Plaud/assets']);
});

test('resolveImages handles URL-encoded @ in paths', async () => {
  const createdFiles = new Map();
  const vault = {
    async ensureFolder() {},
    async listMarkdownFiles() { return []; },
    async read() { return ''; },
    async write() {},
    async create() {},
    async createBinary(path, data) { createdFiles.set(path, data); }
  };

  const md = '![](permanent/abc/card%40tag.png)';
  const imageUrls = [
    {relativePath: 'permanent/abc/card@tag.png', signedUrl: 'https://s3.example.com/permanent/abc/card%40tag.png?sig=a'}
  ];

  const result = await resolveImages({
    vault,
    syncFolder: 'Plaud',
    markdown: md,
    imageUrls,
    fetchBinary: async () => new ArrayBuffer(4)
  });

  // The markdown ref has %40, the signed URL map has @, should still match
  assert.equal(result.downloaded, 1);
  assert.ok(result.markdown.includes('assets/card@tag.png') || result.markdown.includes('assets/card%40tag.png'));
});

test('resolveImages falls back to S3 base URL when no signed URL matches', async () => {
  const createdFiles = new Map();
  const vault = {
    async ensureFolder() {},
    async listMarkdownFiles() { return []; },
    async read() { return ''; },
    async write() {},
    async create() {},
    async createBinary(path, data) { createdFiles.set(path, data); }
  };

  const md = '![](permanent/unknown/image.png)';

  const result = await resolveImages({
    vault,
    syncFolder: 'Plaud',
    markdown: md,
    imageUrls: [],
    fetchBinary: async () => new ArrayBuffer(4)
  });

  assert.equal(result.downloaded, 1);
  assert.ok(result.markdown.includes('assets/image.png'));
  assert.ok(createdFiles.has('Plaud/assets/image.png'));
});

test('resolveImages leaves reference when fetch fails', async () => {
  const vault = {
    async ensureFolder() {},
    async listMarkdownFiles() { return []; },
    async read() { return ''; },
    async write() {},
    async create() {},
    async createBinary() {}
  };

  const md = '![](permanent/unknown/image.png)';

  const result = await resolveImages({
    vault,
    syncFolder: 'Plaud',
    markdown: md,
    imageUrls: [],
    fetchBinary: async () => { throw new Error('forbidden'); }
  });

  assert.equal(result.downloaded, 0);
  assert.ok(result.markdown.includes('permanent/unknown/image.png'));
});
