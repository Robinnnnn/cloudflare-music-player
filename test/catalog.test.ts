import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCatalog } from "../src/catalog";
import type { Catalog } from "../src/types";

function fixture(): Catalog {
  return {
    version: 1,
    tracks: [{ id: "nocturne-1", title: "Nocturne No. 1", artist: "Pianist", objectKey: "v1/nocturne-1-aabbcc.mp3", externalUrl: "https://open.spotify.com/track/example?context=playlist" }],
    playlists: [{ id: "default", title: "Classical", trackIds: ["nocturne-1"] }],
  };
}

test("accepts empty playlists and preserves metadata without mutating the source", () => {
  assert.deepEqual(parseCatalog({ version: 1, tracks: [], playlists: [{ id: "default", title: "Classical", trackIds: [] }] }).tracks, []);
  const input = fixture();
  const parsed = parseCatalog(input);
  assert.deepEqual(parsed, input);
  parsed.playlists[0]!.trackIds.pop();
  assert.equal(input.playlists[0]!.trackIds.length, 1);
});

test("rejects missing and unsupported fields with a usable path", () => {
  const input = fixture();
  assert.throws(() => parseCatalog({ ...input, version: 2 }), /catalog.version must be 1/);
  assert.throws(() => parseCatalog({ ...input, songs: [] }), /catalog.songs is not a supported field/);
  assert.throws(() => parseCatalog({ ...input, tracks: [{ ...input.tracks[0], title: undefined }] }), /tracks\[0\].title must be a non-empty string/);
  assert.throws(() => parseCatalog({ ...input, tracks: [{ ...input.tracks[0], artist: "  " }] }), /artist must be a non-empty string/);
});

test("rejects ambiguous IDs, duplicate IDs and duplicate audio keys", () => {
  const input = fixture();
  for (const badId of ["Upper", "has space", "../path", "double--dash", "-leading", "trailing-"]) {
    assert.throws(() => parseCatalog({ ...input, tracks: [{ ...input.tracks[0], id: badId }] }), /\.id must contain lowercase/);
  }
  assert.throws(() => parseCatalog({ ...input, tracks: [input.tracks[0], { ...input.tracks[0], objectKey: "other.mp3" }] }), /\.id duplicates/);
  assert.throws(() => parseCatalog({ ...input, tracks: [input.tracks[0], { ...input.tracks[0], id: "other" }] }), /\.objectKey duplicates/);
  assert.throws(() => parseCatalog({ ...input, playlists: [...input.playlists, ...input.playlists] }), /\.id duplicates/);
});

test("rejects unknown and repeated playlist references", () => {
  const input = fixture();
  input.playlists[0]!.trackIds.push("absent");
  assert.throws(() => parseCatalog(input), /references unknown track "absent"/);
  input.playlists[0]!.trackIds[1] = "nocturne-1";
  assert.throws(() => parseCatalog(input), /trackIds\[1\] duplicates/);
});

test("rejects absolute paths, traversal, encoded separators and non-MP3 objects", () => {
  for (const objectKey of ["../song.mp3", "folder/../song.mp3", "/song.mp3", "folder//song.mp3", "song.wav", "song.mp3?x=1", "folder%2fsong.mp3", "folder\\song.mp3", "song\n.mp3"]) {
    const input = fixture();
    input.tracks[0]!.objectKey = objectKey;
    assert.throws(() => parseCatalog(input), /\.objectKey/);
  }
});

test("optional links accept HTTP(S) destinations and reject executable or malformed links", () => {
  for (const externalUrl of ["javascript:alert(1)", "data:text/html,hello", "/relative", "https:", "https:example.com", "https://user:password@example.com", "https://example.com\n"]) {
    const input = fixture();
    input.tracks[0]!.externalUrl = externalUrl;
    assert.throws(() => parseCatalog(input), /\.externalUrl/);
  }
  const input = fixture();
  input.tracks[0]!.externalUrl = "http://example.com/song";
  assert.equal(parseCatalog(input).tracks[0]!.externalUrl, "http://example.com/song");
  delete input.tracks[0]!.externalUrl;
  assert.equal(parseCatalog(input).tracks[0]!.externalUrl, undefined);
});
