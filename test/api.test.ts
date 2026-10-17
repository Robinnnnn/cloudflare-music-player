import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler, type Env } from '../src/index';
import type { Catalog } from '../src/types';

const origin = 'https://music.example.com';
const bytes = new TextEncoder().encode('0123456789');
const uploaded = new Date('2026-09-01T12:00:00.123Z');
const etag = '"test-audio-etag"';
const catalog: Catalog = {
  version: 1,
  tracks: [
    { id: 'piano-one', title: 'Piano One', artist: 'Test Performer', objectKey: 'private-path/piano.mp3', externalUrl: 'https://open.spotify.com/track/example' },
    { id: 'strings-two', title: 'Strings Two', artist: 'Another Performer', objectKey: 'private-path/strings.mp3' },
  ],
  playlists: [
    { id: 'default', title: 'Classical', trackIds: ['strings-two', 'piano-one'] },
    { id: 'empty', title: 'Coming soon', trackIds: [] },
  ],
};

type FixtureOptions = { headMissing?: boolean; getMissing?: boolean; changed?: boolean; fail?: 'head' | 'get' };

function fixture(options: FixtureOptions = {}) {
  const reads: { operation: 'head' | 'get'; key: string; options?: R2GetOptions }[] = [];
  const object = { size: bytes.byteLength, etag: 'test-audio-etag', httpEtag: etag, uploaded };
  const bucket = {
    async head(key: string) {
      reads.push({ operation: 'head', key });
      if (options.fail === 'head') throw new Error('private storage error details');
      return options.headMissing ? null : object;
    },
    async get(key: string, getOptions?: R2GetOptions) {
      reads.push({ operation: 'get', key, options: getOptions });
      if (options.fail === 'get') throw new Error('private storage error details');
      if (options.getMissing) return null;
      if (options.changed) return object;
      const range = getOptions?.range as { offset?: number; length?: number } | undefined;
      const start = range?.offset ?? 0;
      const end = range?.length === undefined ? bytes.byteLength : start + range.length;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(start, end));
          controller.close();
        },
      });
      return { ...object, body };
    },
  } as unknown as R2Bucket;
  const assets = { fetch: async () => new Response('export const ready = true;', { headers: { 'Content-Type': 'text/javascript' } }) } as unknown as Fetcher;
  const handler = createHandler(catalog);
  const env: Env = { AUDIO: bucket, ASSETS: assets };
  return {
    reads,
    fetch: (path: string, init?: RequestInit) => handler.fetch(new Request(`${origin}${path}`, init), env),
  };
}

function assertCors(response: Response) {
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
  for (const header of ['Range', 'If-Range', 'If-None-Match', 'If-Modified-Since']) {
    assert.ok(response.headers.get('Access-Control-Allow-Headers')?.split(', ').includes(header));
  }
  for (const header of ['Content-Range', 'Content-Length', 'ETag']) {
    assert.ok(response.headers.get('Access-Control-Expose-Headers')?.split(', ').includes(header));
  }
}

test('playlist responses include public metadata in catalog order and never expose storage keys', async () => {
  const api = fixture();
  const list = await api.fetch('/v1/playlists');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { playlists: [
    { id: 'default', title: 'Classical', trackCount: 2 },
    { id: 'empty', title: 'Coming soon', trackCount: 0 },
  ] });
  const response = await api.fetch('/v1/playlists/default');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Cache-Control')!, /max-age=60/);
  assertCors(response);
  assert.deepEqual(await response.json(), {
    id: 'default', title: 'Classical', tracks: [
      { id: 'strings-two', title: 'Strings Two', artist: 'Another Performer', audioUrl: `${origin}/v1/tracks/strings-two/audio` },
      { id: 'piano-one', title: 'Piano One', artist: 'Test Performer', audioUrl: `${origin}/v1/tracks/piano-one/audio`, externalUrl: 'https://open.spotify.com/track/example' },
    ],
  });
  assert.deepEqual(api.reads, []);
});

test('an empty playlist is a successful response clients can render before songs are uploaded', async () => {
  const response = await fixture().fetch('/v1/playlists/empty');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'empty', title: 'Coming soon', tracks: [] });
});

test('unknown paths, playlist IDs, and arbitrary storage keys return 404 without reading R2', async () => {
  const api = fixture();
  for (const path of ['/v1/playlists/missing', '/v1/tracks/missing/audio', '/v1/tracks/private-path%2Fpiano.mp3/audio', '/private-path/piano.mp3']) {
    const response = await api.fetch(path);
    assert.equal(response.status, 404, path);
    assertCors(response);
  }
  assert.deepEqual(api.reads, []);
});

test('preflight and unsupported methods are handled consistently without touching storage', async () => {
  const api = fixture();
  const preflight = await api.fetch('/v1/tracks/piano-one/audio', {
    method: 'OPTIONS',
    headers: { Origin: 'https://another-project.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'range' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(await preflight.text(), '');
  assertCors(preflight);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await api.fetch('/v1/tracks/piano-one/audio', { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD, OPTIONS');
    assertCors(response);
  }
  assert.deepEqual(api.reads, []);
});

test('full MP3 delivery streams the bytes and includes browser playback metadata', async () => {
  const api = fixture();
  const response = await api.fetch('/v1/tracks/piano-one/audio');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('ETag'), etag);
  assert.equal(response.headers.get('Last-Modified'), uploaded.toUTCString());
  assert.equal(response.headers.get('Content-Range'), null);
  assertCors(response);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.deepEqual(api.reads.map(({ operation, key }) => ({ operation, key })), [
    { operation: 'head', key: 'private-path/piano.mp3' },
    { operation: 'get', key: 'private-path/piano.mp3' },
  ]);
  assert.deepEqual(api.reads[1].options?.onlyIf, { etagMatches: 'test-audio-etag' });
});

for (const [range, text, contentRange] of [
  ['bytes=2-5', '2345', 'bytes 2-5/10'],
  ['bytes=7-', '789', 'bytes 7-9/10'],
  ['bytes=-3', '789', 'bytes 7-9/10'],
  ['bytes=7-999', '789', 'bytes 7-9/10'],
  ['bytes=-999', '0123456789', 'bytes 0-9/10'],
  ['bytes=0-0', '0', 'bytes 0-0/10'],
  ['bytes=8-999999999999999999999999999', '89', 'bytes 8-9/10'],
] as const) {
  test(`a browser request for ${range} receives the correct audio bytes`, async () => {
    const response = await fixture().fetch('/v1/tracks/piano-one/audio', { headers: { Range: range } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('Content-Length'), String(text.length));
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assertCors(response);
    assert.equal(await response.text(), text);
  });
}

test('unsatisfiable byte requests report the full size without fetching the body', async () => {
  const api = fixture();
  for (const range of ['bytes=10-', 'bytes=99-100', 'bytes=-0', 'bytes=7-3', 'bytes=999999999999999999999999-']) {
    const response = await api.fetch('/v1/tracks/piano-one/audio', { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.equal(await response.text(), '');
    assertCors(response);
  }
  assert.ok(api.reads.every(({ operation }) => operation === 'head'));
});

test('unsupported ranges fall back to the full representation', async () => {
  for (const range of ['bytes=0-1,3-4', 'items=1-3', 'bytes=abc', 'bytes=-']) {
    const response = await fixture().fetch('/v1/tracks/piano-one/audio', { headers: { Range: range } });
    assert.equal(response.status, 200, range);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.equal(await response.text(), '0123456789');
  }
});

test('If-Range allows partial playback only for the current strong ETag or a current date', async () => {
  for (const [ifRange, expectedStatus] of [
    [etag, 206],
    [uploaded.toUTCString(), 206],
    ['"old-etag"', 200],
    [`W/${etag}`, 200],
    ['Tue, 01 Sep 2026 11:59:59 GMT', 200],
    ['invalid-date', 200],
  ] as const) {
    const response = await fixture().fetch('/v1/tracks/piano-one/audio', { headers: { Range: 'bytes=2-5', 'If-Range': ifRange } });
    assert.equal(response.status, expectedStatus, ifRange);
    assert.equal(await response.text(), expectedStatus === 206 ? '2345' : '0123456789');
  }
});

test('conditional requests reuse cached audio without fetching the body', async () => {
  const api = fixture();
  for (const headers of [
    { 'If-None-Match': etag },
    { 'If-None-Match': `"other", W/${etag}` },
    { 'If-None-Match': '*' },
    { 'If-Modified-Since': uploaded.toUTCString() },
  ] as Record<string, string>[]) {
    const response = await api.fetch('/v1/tracks/piano-one/audio', { headers });
    assert.equal(response.status, 304);
    assert.equal(response.headers.get('ETag'), etag);
    assert.equal(await response.text(), '');
    assertCors(response);
  }
  assert.ok(api.reads.every(({ operation }) => operation === 'head'));
});

test('If-None-Match takes precedence over modification dates and stale dates return bytes', async () => {
  for (const headers of [
    { 'If-None-Match': '"old-etag"', 'If-Modified-Since': uploaded.toUTCString() },
    { 'If-Modified-Since': 'Tue, 01 Sep 2026 11:59:59 GMT' },
  ] as Record<string, string>[]) {
    const response = await fixture().fetch('/v1/tracks/piano-one/audio', { headers });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '0123456789');
  }
});

test('HEAD returns metadata with no body and audio HEAD avoids downloading the file', async () => {
  const api = fixture();
  const audio = await api.fetch('/v1/tracks/piano-one/audio', { method: 'HEAD', headers: { Range: 'bytes=3-5' } });
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('Content-Length'), '10');
  assert.equal(audio.headers.get('Content-Range'), null);
  assert.equal(await audio.text(), '');
  assertCors(audio);
  for (const path of ['/v1/playlists', '/v1/playlists/default', '/v1/playlists/missing', '/player.js']) {
    const response = await api.fetch(path, { method: 'HEAD' });
    assert.equal(await response.text(), '', path);
    assertCors(response);
  }
  assert.deepEqual(api.reads.map(({ operation }) => operation), ['head']);
});

test('missing audio objects and concurrent replacements return useful errors without exposing storage', async () => {
  for (const [options, status, code] of [
    [{ headMissing: true }, 404, 'audio_not_found'],
    [{ getMissing: true }, 404, 'audio_not_found'],
    [{ changed: true }, 503, 'audio_changed'],
  ] as const) {
    const response = await fixture(options).fetch('/v1/tracks/piano-one/audio');
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, code);
    assert.ok(!text.includes('private-path'));
    assertCors(response);
  }
});

test('storage failures become cross-origin readable temporary errors with no internal details', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const fail of ['head', 'get'] as const) {
    const response = await fixture({ fail }).fetch('/v1/tracks/piano-one/audio');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text();
    assert.equal(JSON.parse(text).error.code, 'service_unavailable');
    assert.ok(!text.includes('private storage error details'));
    assertCors(response);
  }
});

test('health verifies the R2 binding and fails when storage is inaccessible', async (t) => {
  t.mock.method(console, 'error', () => {});
  const api = fixture();
  const response = await api.fetch('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'cloudflare-music-player', version: 1, tracks: 2, playlists: 2 });
  assert.equal(api.reads.length, 1);
  assert.equal(api.reads[0].operation, 'head');
  const unavailable = await fixture({ fail: 'head' }).fetch('/health');
  assert.equal(unavailable.status, 503);
});
