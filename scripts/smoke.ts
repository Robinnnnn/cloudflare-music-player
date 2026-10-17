import assert from 'node:assert/strict';
import type { Playlist } from '../src/types';

const endpoint = process.argv[2] ?? process.env.MUSIC_BASE_URL;
if (!endpoint) throw new Error('Usage: npm run smoke -- http://localhost:8787 (or set MUSIC_BASE_URL)');
const address = new URL(endpoint);
if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
  throw new Error('MUSIC_BASE_URL must be an HTTP(S) origin without credentials, a path, or query parameters.');
}
const baseUrl = address.origin;
const origin = 'https://app.example.com';

async function main() {
  const [healthResponse, listResponse, moduleResponse, preflight] = await Promise.all([
    fetch(`${baseUrl}/health`),
    fetch(`${baseUrl}/v1/playlists`, { headers: { Origin: origin } }),
    fetch(`${baseUrl}/player.js`, { headers: { Origin: origin } }),
    fetch(`${baseUrl}/v1/playlists`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' } }),
  ]);
  assert.equal(healthResponse.status, 200, 'health endpoint');
  const health = await healthResponse.json() as { ok: boolean; tracks: number };
  assert.equal(health.ok, true, 'R2 connectivity');
  assert.equal(listResponse.status, 200, 'playlist list');
  assert.equal(listResponse.headers.get('access-control-allow-origin'), '*', 'catalog CORS');
  assert.equal(moduleResponse.status, 200, 'browser module');
  assert.match(moduleResponse.headers.get('content-type') ?? '', /javascript/, 'module MIME');
  assert.equal(moduleResponse.headers.get('access-control-allow-origin'), '*', 'module CORS');
  assert.match(await moduleResponse.text(), /createMusicPlayer/, 'module export');
  assert.equal(preflight.status, 204, 'CORS preflight');
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

  const { playlists } = await listResponse.json() as { playlists: { id: string; trackCount: number }[] };
  let checkedAudio = false;
  for (const summary of playlists) {
    const response = await fetch(`${baseUrl}/v1/playlists/${summary.id}`);
    assert.equal(response.status, 200, `playlist ${summary.id}`);
    const playlist = await response.json() as Playlist;
    assert.equal(playlist.tracks.length, summary.trackCount);
    const track = playlist.tracks[0];
    if (!track || checkedAudio) continue;
    const head = await fetch(track.audioUrl, { method: 'HEAD' });
    assert.equal(head.status, 200, 'audio metadata');
    const size = Number(head.headers.get('content-length'));
    assert.ok(size > 0, 'nonempty audio');
    const length = Math.min(size, 32);
    const partial = await fetch(track.audioUrl, { headers: { Range: `bytes=0-${length - 1}`, Origin: origin } });
    assert.equal(partial.status, 206, 'audio byte range');
    assert.equal(partial.headers.get('content-range'), `bytes 0-${length - 1}/${size}`);
    assert.equal((await partial.arrayBuffer()).byteLength, length);
    const etag = head.headers.get('etag');
    assert.ok(etag, 'audio ETag');
    const cached = await fetch(track.audioUrl, { headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304, 'audio cache validator');
    checkedAudio = true;
  }
  console.log(`Live checks passed: ${playlists.length} playlists, ${health.tracks} tracks, public module, CORS, and R2 health.`);
  console.log(checkedAudio ? 'Live audio ranges and cache validation passed.' : 'Catalog is empty; live MP3 playback checks await supplied files.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
