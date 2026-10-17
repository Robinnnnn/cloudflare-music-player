# Cloudflare Music Player

A small music API backed by Cloudflare Workers and R2, with a framework-free browser player. Supply your own catalog and recordings; the repository starts with an empty `default` playlist and contains no audio or production account configuration.

The browser player keeps one audio element, shuffles without immediate repeats, advances when a song ends, supports optional opening-song pools, and can preload one upcoming recording. A lower-level audio engine is also available for apps that own their own sequence, timing, fades, or local files.

The audio-preparation tool trims blank introductions and matches perceived track volume while preserving musical dynamics. Preparation happens before upload; playback volume and fades are controlled separately.

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

## Audio preparation and loudness

Use Python 3 and FFmpeg to prepare a recording before uploading it:

```sh
python3 scripts/prepare-audio.py \
  --file /path/to/original.mp3 \
  --output /path/to/prepared.mp3
```

The tool writes a new MP3 and a JSON measurement report. It preserves the original and leaves uploading and catalog changes to the separate upload command. Use the prepared file with `npm run track:add` when ready.

### Silence trimming

The default detector trims only silence at the very beginning, below −60 dB and lasting at least 300 ms. It leaves an 80 ms cushion before the first sound and preserves internal pauses, quiet passages, and endings.

A brief opening click or room noise can hide a blank introduction from the conservative detector. Inspect the opening before changing `--silence-threshold-db` (for example, to `-40`), or use `--trim-seconds` for an exact inspected cut. An explicit cut overrides detection; include the desired cushion in the supplied time. The report records how much was trimmed and whether the cut was detected or explicit.

### Matching perceived volume

The default target is **−24 LUFS**, suited to gentle background playback. The tool measures integrated loudness, loudness range, and true peak, then applies one constant gain to the whole recording. This preserves the difference between quiet and loud passages.

The default maximum boost is **+12 dB**, and the true-peak target is **−2 dBTP**. Peak headroom takes priority over the loudness target: a recording with large peaks can remain quieter. The encoded MP3 is measured again and, when necessary, regenerated from the original at lower gain to account for encoder overshoot.

`--target-lufs` changes the target between −30 and −14 LUFS. For an inspected, exceptionally quiet source, `--max-gain-db` can raise the boost cap up to 24 dB while retaining peak protection. For example:

```sh
python3 scripts/prepare-audio.py \
  --file /path/to/original.mp3 \
  --output /path/to/prepared.mp3 \
  --target-lufs -24 --max-gain-db 18
```

### Optional gentle leveling

`--gentle-leveling` permits up to **3 dB of estimated peak reduction** for recordings whose peaks prevent constant gain from reaching the target. It activates only when constant gain misses by more than 0.5 LU and limiting can add more than 0.5 dB; other tracks keep the constant-gain path. The configured boost cap still applies.

The limiter uses 192 kHz oversampling, a −2.2 dB ceiling, 5 ms attack, 100 ms release, and delay compensation before encoding at 48 kHz. Encoded true peaks are rechecked and the ceiling lowered when needed. This can bring peak-limited tracks closer to the collection's volume while retaining quiet musical passages.

The JSON report includes before/after loudness, loudness range, true peak, applied gain, trimming, warnings, and processing mode. Listen to the result alongside neighboring tracks: equal whole-track LUFS does not make every passage sound equally loud. Record intentional per-track target overrides so later replacements preserve those choices.

When removing applause or another unwanted tail, choose the retained music first and normalize that segment; audience noise can skew whole-file loudness. Preserve source timestamps and any boundary fades. Preparation re-encodes MP3, so keep the originals and prepare future revisions from the original or a lossless intermediate.

Existing audio checks include real FFmpeg encodes for trimming, peak protection, limiter delay, ending preservation, and original-file preservation:

```sh
npm run test:audio
```

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

Import `createMusicPlayer` from your own service's `/player.js` module and configure `baseUrl` and `playlistId`. Subscribe to playback state to connect your app's controls; `subscribe()` immediately supplies the current state and returns an unsubscribe function. The full options and state contracts are in [`client/player-types.ts`](client/player-types.ts).

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
