import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getPlatformProxy } from 'wrangler';
import { createHandler, type Env } from '../src/index';

test('audio responses work with an actual local R2 binding and stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'music-worker-r2-'));
  const configPath = join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify({
    name: 'music-worker-local-test',
    compatibility_date: '2026-09-07',
    r2_buckets: [{ binding: 'AUDIO', bucket_name: 'music-worker-local-test' }],
  }));
  const proxy = await getPlatformProxy<{ AUDIO: R2Bucket }>({ configPath, persist: false, remoteBindings: false });
  try {
    const bytes = new TextEncoder().encode('a small binary fixture for testing byte ranges');
    await proxy.env.AUDIO.put('fixture.mp3', bytes, { httpMetadata: { contentType: 'audio/mpeg' } });
    const handler = createHandler({
      version: 1,
      tracks: [{ id: 'fixture', title: 'Fixture', artist: 'Test', objectKey: 'fixture.mp3' }],
      playlists: [{ id: 'default', title: 'Classical', trackIds: ['fixture'] }],
    });
    const env = { AUDIO: proxy.env.AUDIO } as Env;
    const request = (headers?: HeadersInit) => new Request('https://music.example/v1/tracks/fixture/audio', { headers });
    const full = await handler.fetch(request(), env);
    assert.equal(full.status, 200);
    assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
    const partial = await handler.fetch(request({ Range: 'bytes=2-10' }), env);
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('Content-Range'), `bytes 2-10/${bytes.length}`);
    assert.equal(partial.headers.get('Content-Length'), '9');
    assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), bytes.slice(2, 11));
    const cached = await handler.fetch(request({ 'If-None-Match': full.headers.get('ETag')! }), env);
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
  } finally {
    await proxy.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
