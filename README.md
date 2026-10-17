# Cloudflare Music Player

A small music API backed by Cloudflare Workers and R2, with a framework-free browser player. Supply your own catalog and recordings; the repository starts with an empty `default` playlist and contains no audio or production account configuration.

The browser player keeps one audio element, shuffles without immediate repeats, advances when a song ends, supports optional opening-song pools, and can preload one upcoming recording. A lower-level audio engine is also available for apps that own their own sequence, timing, fades, or local files.

## Run locally

Requires Node.js 22.18 or later and npm. FFmpeg is optional for audio preparation and its integration tests.

```sh
npm ci
npm run dev
```

Wrangler serves the API and browser module at `http://localhost:8787`. Local R2 storage is isolated from a deployed bucket. The initial playlist is empty, so the player reports `empty` until you supply audio.

Add an MP3 you intend to serve, using a stable unique ID:

```sh
npm run track:add -- --file /path/to/recording.mp3 --id recording-one --title "Example recording" --artist "Example artist" --playlist default --local
npm run catalog:check
```

The command uploads to local R2 and updates `catalog/catalog.json`. Audio files, local Wrangler state, environment files, and generated bundles are ignored by Git. Only cataloged object keys can be served. Catalog metadata and audio become public when deployed; use this service for recordings you intend to share.

## Catalog

`catalog/catalog.json` is the source of truth:

```json
{
  "version": 1,
  "tracks": [
    {
      "id": "recording-one",
      "title": "Example recording",
      "artist": "Example artist",
      "objectKey": "v1/recording-one-content-hash.mp3"
    }
  ],
  "playlists": [
    { "id": "default", "title": "My playlist", "trackIds": ["recording-one"] }
  ]
}
```

This example shows the format; its object does not exist until you upload a recording. The upload command creates a content-addressed key. Keep IDs stable and keys immutable; use a new key for replacement audio. Optional `externalUrl` values must be HTTP(S) links without embedded credentials. The validator checks duplicate IDs/keys, invalid paths, unsupported fields, and playlist references.

Add more playlist objects and pass their IDs to the player. Opening-song pools are ordinary playlists containing IDs from the main playlist.

## Browser integration

Import the module from your own running service. Replace the local origin when deploying:

```html
<button id="music" disabled>Loading music…</button>
<span id="track"></span>
<script type="module">
  import { createMusicPlayer } from 'http://localhost:8787/player.js';

  const player = createMusicPlayer({
    baseUrl: 'http://localhost:8787',
    playlistId: 'default',
    preloadNext: true,
  });
  const button = document.querySelector('#music');
  const label = document.querySelector('#track');
  player.subscribe(({ status, track, error }) => {
    button.disabled = ['idle', 'loading', 'empty', 'destroyed'].includes(status);
    button.textContent = status === 'empty' ? 'Playlist is empty'
      : ['playing', 'buffering'].includes(status) ? 'Pause music' : 'Play music';
    label.textContent = error ?? (track ? `${track.title} — ${track.artist}` : '');
  });
  button.addEventListener('click', () => { void player.toggle(); });
  void player.prepare();
  // Call player.destroy() when the owning app/session ends.
</script>
```

Keep the player alive when menus or dialogs close. `prepare()` fetches metadata and selects the first track without playing. Call `play()`, `toggle()`, or `playNext()` directly from a user gesture. Operational failures appear in subscribed `state.error`; these methods do not reject for ordinary playback failures. `pause()` retains position; `destroy()` aborts work and releases the element.

`openingPlaylistId` optionally limits the first selection. `secondPlaylistId` expands the second-song pool using the union of the two pools, excluding the opener. Missing, empty, invalid, or unavailable pools fall back to the ordinary shuffle. Preloading retains at most one upcoming recording and falls back to streaming if it is unfinished or fails.

## Bundled apps and lower-level audio

`npm run build:package` produces ESM and TypeScript declarations in `dist/`. `npm pack` makes a local package archive; install the archive in a consumer and commit its lockfile. No npm registry package is published by this repository.

```js
import { createMusicPlayer } from 'cloudflare-music-player';
import { createAudioPlayer } from 'cloudflare-music-player/audio';
```

Choose one playback owner. `createAudioPlayer` supports file/stream loading, position, output fades, silent gesture preparation, one-next-stream preloading, cancellation, and native iOS output. Its loading/play operations reject on failure. See `client/audio-types.ts` for the contract. Browser automation and unit tests do not establish physical-device audio or background reliability.

## API

| Endpoint | Response |
| --- | --- |
| `/health` | Catalog counts and an R2 connectivity check |
| `/v1/playlists` | Playlist summaries |
| `/v1/playlists/:id` | Track metadata and public audio URLs |
| `/v1/tracks/:id/audio` | MP3 bytes, byte ranges, ETag and conditional reads |
| `/player.js` | Browser ESM player |

The API supports `GET`, `HEAD`, and CORS preflight. Cross-origin reads are intentionally public. R2 itself stays private; there is no HTTP upload or catalog-mutation endpoint. Internal object keys are omitted from playlist responses.

## Deploy your own service

Choose your own Worker and bucket names in `wrangler.jsonc`. No account ID is included; Wrangler uses your authenticated account or a `CLOUDFLARE_ACCOUNT_ID` supplied by your shell/CI. Keep credentials in Wrangler's secret store or your CI environment.

```sh
npx wrangler login
npx wrangler r2 bucket create cloudflare-music-audio
# For a fresh empty catalog:
npm run track:add -- --file /path/to/recording.mp3 --id recording-one --title "Example recording" --artist "Example artist" --playlist default
npm run deploy
```

If you already followed the local quickstart, do not add the same ID again. Upload the existing file under its exact `objectKey` from `catalog/catalog.json` instead:

```sh
npx wrangler r2 object put 'cloudflare-music-audio/v1/REPLACE-WITH-OBJECT-KEY.mp3' --file /path/to/recording.mp3 --content-type audio/mpeg --remote
```

Repeat for each local-only entry, using its actual catalog key, or remove local-only entries before deploying. The upload command rejects duplicate IDs rather than silently replacing audio. `npm run deploy` runs local checks, verifies referenced remote objects using R2 metadata, then deploys. Uploads/deploys are explicit authenticated CLI operations. CI runs checks without deploying.

## Verify

```sh
npm run check
npm run smoke -- http://localhost:8787
# For a deployed service, pass its origin explicitly or set MUSIC_BASE_URL.
```

The check covers catalog validation, TypeScript, API/player tests, actual isolated local R2 reads, audio preparation tests, package/client builds, and a Wrangler dry run. FFmpeg-dependent tests skip when FFmpeg is unavailable. Smoke checks cover API/module/CORS/R2 health and, when the catalog has audio, range and cache behavior. No remote service is assumed by default.

No project license has been added. Dependency licenses remain governed by their respective packages.
