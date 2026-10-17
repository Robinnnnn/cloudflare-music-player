import type { Catalog, CatalogPlaylist, CatalogTrack } from "./types";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.mp3$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function record(input: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${path} must be an object`);
  }
  const value = input as Record<string, unknown>;
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw new Error(`${path}.${field} is not a supported field`);
  }
  return value;
}

function text(input: unknown, path: string, maxLength = 250): string {
  if (typeof input !== "string" || !input.trim()) throw new Error(`${path} must be a non-empty string`);
  if (input !== input.trim()) throw new Error(`${path} must not have leading or trailing whitespace`);
  if (input.length > maxLength || CONTROL.test(input)) {
    throw new Error(`${path} must be at most ${maxLength} characters and contain no control characters`);
  }
  return input;
}

function id(input: unknown, path: string): string {
  const value = text(input, path, 80);
  if (!ID.test(value)) throw new Error(`${path} must contain lowercase letters or numbers separated by single hyphens`);
  return value;
}

function array(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) throw new Error(`${path} must be an array`);
  return input;
}

function unique(value: string, seen: Set<string>, path: string): void {
  if (seen.has(value)) throw new Error(`${path} duplicates "${value}"`);
  seen.add(value);
}

/** Validate the whole catalog before accepting it, including cross-playlist references. */
export function parseCatalog(input: unknown): Catalog {
  const source = record(input, "catalog", ["version", "tracks", "playlists"]);
  if (source.version !== 1) throw new Error("catalog.version must be 1");
  const trackIds = new Set<string>();
  const objectKeys = new Set<string>();
  const tracks: CatalogTrack[] = array(source.tracks, "catalog.tracks").map((input, index) => {
    const path = `catalog.tracks[${index}]`;
    const value = record(input, path, ["id", "title", "artist", "objectKey", "externalUrl"]);
    const trackId = id(value.id, `${path}.id`);
    unique(trackId, trackIds, `${path}.id`);
    const objectKey = text(value.objectKey, `${path}.objectKey`, 512);
    if (!OBJECT_KEY.test(objectKey) || objectKey.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`${path}.objectKey must be a relative .mp3 key using letters, numbers, hyphens, underscores, periods, or slashes; traversal is not allowed`);
    }
    unique(objectKey, objectKeys, `${path}.objectKey`);
    const track: CatalogTrack = {
      id: trackId,
      title: text(value.title, `${path}.title`),
      artist: text(value.artist, `${path}.artist`),
      objectKey,
    };
    if ("externalUrl" in value) {
      const externalUrl = text(value.externalUrl, `${path}.externalUrl`, 2048);
      let url: URL;
      try { url = new URL(externalUrl); } catch { throw new Error(`${path}.externalUrl must be an absolute http or https URL`); }
      if (!/^https?:\/\//.test(externalUrl) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) {
        throw new Error(`${path}.externalUrl must be an absolute http or https URL without credentials`);
      }
      track.externalUrl = externalUrl;
    }
    return track;
  });
  const playlistIds = new Set<string>();
  const playlists: CatalogPlaylist[] = array(source.playlists, "catalog.playlists").map((input, index) => {
    const path = `catalog.playlists[${index}]`;
    const value = record(input, path, ["id", "title", "trackIds"]);
    const playlistId = id(value.id, `${path}.id`);
    unique(playlistId, playlistIds, `${path}.id`);
    const playlistTracks = new Set<string>();
    return {
      id: playlistId,
      title: text(value.title, `${path}.title`),
      trackIds: array(value.trackIds, `${path}.trackIds`).map((input, trackIndex) => {
        const trackPath = `${path}.trackIds[${trackIndex}]`;
        const trackId = id(input, trackPath);
        unique(trackId, playlistTracks, trackPath);
        if (!trackIds.has(trackId)) throw new Error(`${trackPath} references unknown track "${trackId}"`);
        return trackId;
      }),
    };
  });
  return { version: 1, tracks, playlists };
}
