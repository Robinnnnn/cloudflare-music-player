import rawCatalog from '../catalog/catalog.json';
import { parseCatalog } from './catalog';
import type { Catalog, CatalogTrack, Track } from './types';

export interface Env {
  AUDIO: R2Bucket;
  ASSETS: Fetcher;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Range, If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified',
  'X-Content-Type-Options': 'nosniff',
};

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function publicTrack(track: CatalogTrack, origin: string): Track {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    audioUrl: `${origin}/v1/tracks/${track.id}/audio`,
    ...(track.externalUrl ? { externalUrl: track.externalUrl } : {}),
  };
}

// Unsupported or malformed ranges are ignored; a valid unsatisfiable range is 416.
export function parseRange(value: string | null, size: number): { offset: number; length: number } | null | 'unsatisfiable' {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const total = BigInt(size);
  if (!size) return 'unsatisfiable';
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (!suffix) return 'unsatisfiable';
    const length = suffix > total ? total : suffix;
    return { offset: Number(total - length), length: Number(length) };
  }
  const start = BigInt(match[1]);
  const requestedEnd = match[2] ? BigInt(match[2]) : total - 1n;
  if (start >= total || requestedEnd < start) return 'unsatisfiable';
  const end = requestedEnd >= total ? total - 1n : requestedEnd;
  return { offset: Number(start), length: Number(end - start + 1n) };
}

function matchesEtag(value: string, etag: string): boolean {
  return value.split(',').some((item) => item.trim() === '*' || item.trim().replace(/^W\//, '') === etag);
}

function notModifiedSince(value: string, uploaded: Date): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && Math.floor(uploaded.getTime() / 1000) <= Math.floor(timestamp / 1000);
}

async function audio(request: Request, bucket: R2Bucket, track: CatalogTrack): Promise<Response> {
  const object = await bucket.head(track.objectKey);
  if (!object) return error(404, 'audio_not_found', 'This track’s audio has not been uploaded.');
  const headers = new Headers({
    'Content-Type': 'audio/mpeg',
    'Content-Length': String(object.size),
    'Accept-Ranges': 'bytes',
    'ETag': object.httpEtag,
    'Last-Modified': object.uploaded.toUTCString(),
    'Cache-Control': 'public, max-age=300, must-revalidate',
  });
  const ifNoneMatch = request.headers.get('If-None-Match');
  const ifModifiedSince = request.headers.get('If-Modified-Since');
  if (ifNoneMatch !== null
    ? matchesEtag(ifNoneMatch, object.httpEtag)
    : ifModifiedSince !== null && notModifiedSince(ifModifiedSince, object.uploaded)) {
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') return new Response(null, { headers });

  const ifRange = request.headers.get('If-Range');
  const canRange = !ifRange || ifRange === object.httpEtag
    || (!ifRange.startsWith('"') && !ifRange.startsWith('W/') && notModifiedSince(ifRange, object.uploaded));
  const range = canRange ? parseRange(request.headers.get('Range'), object.size) : null;
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${object.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
    });
  }
  const body = await bucket.get(track.objectKey, {
    onlyIf: { etagMatches: object.etag },
    ...(range ? { range } : {}),
  });
  if (!body) return error(404, 'audio_not_found', 'This track’s audio is unavailable.');
  if (!('body' in body)) return error(503, 'audio_changed', 'This track changed while loading. Please retry.');
  if (range) {
    const { offset = 0, length = object.size } = range;
    headers.set('Content-Length', String(length));
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
  }
  return new Response(body.body, { status: range ? 206 : 200, headers });
}

export function createHandler(catalog: Catalog) {
  const tracks = new Map(catalog.tracks.map((track) => [track.id, track]));
  const playlists = new Map(catalog.playlists.map((playlist) => [playlist.id, playlist]));
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      let response: Response;
      try {
        const url = new URL(request.url);
        const path = url.pathname;
        if (request.method === 'OPTIONS') {
          response = new Response(null, { status: 204, headers: { 'Access-Control-Max-Age': '86400' } });
        } else if (request.method !== 'GET' && request.method !== 'HEAD') {
          response = error(405, 'method_not_allowed', 'Only GET, HEAD, and OPTIONS are supported.');
          response.headers.set('Allow', 'GET, HEAD, OPTIONS');
        } else if (path === '/health') {
          // Read a reserved, non-catalog key to verify that the deployed R2 binding works.
          await env.AUDIO.head('__music_worker_health__');
          response = json({ ok: true, service: 'cloudflare-music-player', version: 1, tracks: tracks.size, playlists: playlists.size });
        } else if (path === '/') {
          response = json({ service: 'cloudflare-music-player', apiVersion: 1, playlistsUrl: `${url.origin}/v1/playlists`, playerUrl: `${url.origin}/player.js` });
        } else if (path === '/v1/playlists') {
          response = json({ playlists: catalog.playlists.map(({ id, title, trackIds }) => ({ id, title, trackCount: trackIds.length })) }, 200, { 'Cache-Control': 'public, max-age=60' });
        } else if (/^\/v1\/playlists\/[a-z0-9-]+$/.test(path)) {
          const playlist = playlists.get(path.split('/')[3]);
          response = playlist
            ? json({ id: playlist.id, title: playlist.title, tracks: playlist.trackIds.map((id) => publicTrack(tracks.get(id)!, url.origin)) }, 200, { 'Cache-Control': 'public, max-age=60' })
            : error(404, 'playlist_not_found', 'Playlist not found.');
        } else if (/^\/v1\/tracks\/[a-z0-9-]+\/audio$/.test(path)) {
          const track = tracks.get(path.split('/')[3]);
          response = track ? await audio(request, env.AUDIO, track) : error(404, 'track_not_found', 'Track not found.');
        } else if (path === '/player.js') {
          response = await env.ASSETS.fetch(request);
          response = new Response(response.body, response);
          response.headers.set('Cache-Control', 'public, max-age=300, must-revalidate');
        } else {
          response = error(404, 'not_found', 'Endpoint not found.');
        }
      } catch (cause) {
        console.error('Music request failed', cause instanceof Error ? cause.message : 'Unknown error');
        response = error(503, 'service_unavailable', 'Music is temporarily unavailable. Please retry.');
      }
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}

export default createHandler(parseCatalog(rawCatalog));
