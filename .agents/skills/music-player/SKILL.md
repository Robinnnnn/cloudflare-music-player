---
name: music-player
description: Integrate a self-hosted Cloudflare music player into a browser app, including configurable playlists, next-song preloading, buffering, retries, cancellation, and native iOS output.
---

# Music player integration

Read this repository's `README.md`, package exports, and client TypeScript contracts before changing a consumer. Keep reusable playback behavior in the library and presentation/playlist policy in the app.

## Choose one playback owner

- `createMusicPlayer` fetches a configured playlist from the consumer's chosen `baseUrl`, shuffles, advances, optionally selects opening-song pools, and preloads one next recording. Subscribe to `state.error` for operational failures.
- `createAudioPlayer` gives an app explicit control over file/stream loading, sequencing, position, fades, and gesture timing. Its load/play operations reject on failure.

Keep one selected player alive for its app/session. Do not recreate it when controls open or close. Dispose it when its owner ends.

## Configure and distribute deliberately

Never hardcode a particular production service, account, or personal catalog. Use the consumer's configured service origin and playlist ID. Use a pinned package archive/lockfile for bundled apps, or the consumer's own `/player.js` endpoint for hosted imports. A query parameter on a mutable hosted module is only a cache key.

## Playback behavior

Prepare a selected track before playback and call play/toggle directly from a user gesture. For animation-gated playback, prepare silently in the gesture and play only when the app reaches its actual contact/start condition. Cancel pending playback on pause/disposal.

Treat `buffering` as a pending playback request. Preserve track/position on errors and offer an explicit retry. Preload only the known next recording; unfinished/failed speculative loading falls back to streaming. Do not describe this as gapless playback.

Native iOS volume/output behavior differs from desktop Web Audio. Preserve muted activation and native output paths. Test actual device audio when available; a timer or reported gain alone does not establish sound.

## Verify

Run the library's checks and the consumer's existing build/tests. Exercise play, pause, rapid reversal/cancellation, natural advancement, buffering/retry, and teardown. State which browser/device checks were actually performed. Uploading recordings, changing a production catalog, and deploying are separate explicit operations.
