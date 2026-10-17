import { createStreamPreloader } from './preload.js';
import type { Playlist, Track } from './player-types.js';

export type MusicPlayerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'empty'
  | 'error'
  | 'destroyed';

export interface MusicPlayerState {
  readonly status: MusicPlayerStatus;
  readonly playlist: Readonly<Omit<Playlist, 'tracks'>> & {
    readonly tracks: readonly Readonly<Track>[];
  } | null;
  readonly track: Readonly<Track> | null;
  readonly error: string | null;
}

/** The subset of HTMLAudioElement used by the player; injectable for tests. */
export interface MusicAudio {
  src: string;
  preload: string;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly error?: { readonly message?: string; readonly code?: number } | null;
  play(): Promise<void> | void;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface MusicPlayerOptions {
  baseUrl: string;
  playlistId?: string;
  /** Choose the first song from this playlist, then shuffle the full main playlist. */
  openingPlaylistId?: string;
  /** The second choice adds this pool to the opening pool, excluding the first song. */
  secondPlaylistId?: string;
  audioFactory?: () => MusicAudio;
  /** Keep one upcoming recording in memory for fast gesture-driven advancement. */
  preloadNext?: boolean;
  fetch?: typeof globalThis.fetch;
  random?: () => number;
}

export interface MusicPlayer {
  readonly state: MusicPlayerState;
  /** Fetch the catalog and preload the first selection without playing it. */
  prepare(): Promise<void>;
  /** Call directly from a click/tap; prepare beforehand for mobile browsers. */
  play(): Promise<void>;
  /** Advance the shuffle and play in the same gesture; optionally exclude the last visible track. */
  playNext(excludeTrackId?: string): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  /** Immediately receives the current state. Returns an unsubscribe function. */
  subscribe(listener: (state: MusicPlayerState) => void): () => void;
  destroy(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to play music.';
}

function parsePlaylist(value: unknown, baseUrl: string): NonNullable<MusicPlayerState['playlist']> {
  if (!value || typeof value !== 'object') throw new Error('Invalid playlist response.');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string' || !Array.isArray(candidate.tracks)) {
    throw new Error('Invalid playlist response.');
  }
  const ids = new Set<string>();
  const tracks = candidate.tracks.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid playlist track.');
    const track = value as Record<string, unknown>;
    for (const field of ['id', 'title', 'artist', 'audioUrl'] as const) {
      if (typeof track[field] !== 'string' || !track[field].trim()) throw new Error(`Invalid track ${field}.`);
    }
    const id = track.id as string;
    if (ids.has(id)) throw new Error(`Duplicate track ID: ${id}.`);
    ids.add(id);
    const audioUrl = new URL(track.audioUrl as string, `${baseUrl}/`);
    if (!['https:', 'http:'].includes(audioUrl.protocol)) throw new Error('Invalid track audio URL.');
    const result: Track = { id, title: track.title as string, artist: track.artist as string, audioUrl: audioUrl.href };
    if (track.externalUrl !== undefined) {
      if (typeof track.externalUrl !== 'string') throw new Error('Invalid external track URL.');
      const externalUrl = new URL(track.externalUrl);
      if (!['https:', 'http:'].includes(externalUrl.protocol)) throw new Error('Invalid external track URL.');
      result.externalUrl = externalUrl.href;
    }
    return Object.freeze(result);
  });
  return Object.freeze({ id: candidate.id, title: candidate.title, tracks: Object.freeze(tracks) });
}

/**
 * One independent shuffled queue and one persistent audio element per instance.
 * Async failures are reported in state, rather than rejected promises. A failed
 * track stops playback; another user gesture can retry it. Nothing auto-skips.
 */
export function createMusicPlayer(options: MusicPlayerOptions): MusicPlayer {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const endpoint = `${baseUrl}/v1/playlists/${encodeURIComponent(options.playlistId ?? 'default')}`;
  const fetchPlaylist = options.fetch ?? globalThis.fetch.bind(globalThis);
  const random = options.random ?? Math.random;
  const listeners = new Set<(state: MusicPlayerState) => void>();
  let state: MusicPlayerState = Object.freeze({ status: 'idle', playlist: null, track: null, error: null });
  let audio: MusicAudio | undefined;
  let disposed = false;
  let prepared = false;
  let desiredPlaying = false;
  let needsReload = false;
  let command = 0;
  let queue: Readonly<Track>[] = [];
  let preparation: Promise<void> | undefined;
  let playback: { command: number; promise: Promise<void> } | undefined;
  let controller: AbortController | undefined;
  let cancelPlay: (() => void) | undefined;
  let activeObjectUrl: string | undefined;
  const preloader = createStreamPreloader(fetchPlaylist);

  function inform(listener: (state: MusicPlayerState) => void): void {
    // A consumer's render error must not break cleanup or leave play() rejected.
    try { listener(state); } catch (error) { console.error('Music player listener failed:', error); }
  }

  function update(changes: Partial<MusicPlayerState>): void {
    if (disposed && changes.status !== 'destroyed') return;
    state = Object.freeze({ ...state, ...changes });
    for (const listener of listeners) inform(listener);
  }

  function cancelIntent(): void {
    desiredPlaying = false;
    command += 1;
    cancelPlay?.();
    cancelPlay = undefined;
  }

  function fail(error: unknown): void {
    if (disposed) return;
    cancelIntent();
    needsReload = prepared;
    update({ status: 'error', error: errorMessage(error) });
    audio?.pause();
  }

  function nextTrack(excludeTrackId = state.track?.id, consume = true): Readonly<Track> | undefined {
    // A closing UI can still show the previous track while an ended event has
    // advanced internally. Never select that visible track again on reopening.
    if (queue.length === 1 && queue[0]!.id === excludeTrackId && (state.playlist?.tracks.length ?? 0) > 1) queue = [];
    if (!queue.length && state.playlist) {
      queue = [...state.playlist.tracks];
      for (let i = queue.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [queue[i], queue[j]] = [queue[j]!, queue[i]!];
      }
    }
    if (queue.length > 1 && queue[0]!.id === excludeTrackId) {
      [queue[0], queue[1]] = [queue[1]!, queue[0]!];
    }
    return consume ? queue.shift() : queue[0];
  }

  function preloadUpcoming(): void {
    if (!options.preloadNext || disposed || !desiredPlaying) return;
    const track = nextTrack(state.track?.id, false);
    if (track) preloader.preload(track.audioUrl);
  }

  function selectTrack(track: Readonly<Track>): void {
    const previousUrl = activeObjectUrl;
    const cached = preloader.take(track.audioUrl);
    activeObjectUrl = cached ? URL.createObjectURL(cached) : undefined;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    needsReload = false;
    update({ track, status: 'ready', error: null });
    if (disposed) return;
    audio!.src = activeObjectUrl ?? track.audioUrl;
    audio!.load();
  }

  function isCurrent(version: number): boolean {
    return !disposed && desiredPlaying && command === version;
  }

  async function startPlayback(version: number): Promise<void> {
    if (!isCurrent(version) || !audio || !state.track) return;
    const currentAudio = audio;
    let cancel: (() => void) | undefined;
    try {
      if (needsReload) {
        needsReload = false;
        currentAudio.load();
      }
      if (!isCurrent(version)) return;
      update({ status: 'buffering', error: null });
      if (!isCurrent(version)) return;
      const canceled = new Promise<void>((resolve) => { cancel = resolve; });
      cancelPlay = cancel;
      // This call intentionally happens synchronously in the user's gesture
      // whenever prepare() has already completed.
      const started = Promise.resolve(currentAudio.play()).then(() => {
        if (disposed || !desiredPlaying) currentAudio.pause();
      });
      await Promise.race([started, canceled]);
      // The 'playing' event, not play() resolving, reports actual playback.
    } catch (error) {
      if (isCurrent(version)) fail(error);
    } finally {
      if (cancelPlay === cancel) cancelPlay = undefined;
    }
  }

  const events: Record<string, EventListener> = {
    playing: () => {
      if (disposed || !audio) return;
      if (!desiredPlaying) { audio.pause(); return; }
      update({ status: 'playing', error: null });
      preloadUpcoming();
    },
    waiting: () => {
      if (!disposed && desiredPlaying && state.track && !audio?.paused) update({ status: 'buffering' });
    },
    pause: () => {
      if (disposed || !audio?.paused || audio.ended || !state.track || state.status === 'error') return;
      cancelIntent();
      update({ status: 'paused' });
    },
    ended: () => {
      if (disposed || !desiredPlaying || !audio?.ended) return;
      command += 1;
      cancelPlay?.();
      try {
        const track = nextTrack();
        if (track) {
          selectTrack(track);
          void startPlayback(command);
        }
      } catch (error) { fail(error); }
    },
    error: () => fail(new Error(audio?.error?.message || 'Unable to load this audio file. Tap play to retry.')),
  };

  async function curatedTrackIds(playlistId: string | undefined, parentSignal: AbortSignal): Promise<Set<string> | null> {
    if (!playlistId) return null;
    const request = new AbortController();
    const cancel = () => request.abort();
    parentSignal.addEventListener('abort', cancel, { once: true });
    const deadline = setTimeout(cancel, 2000);
    try {
      const url = `${baseUrl}/v1/playlists/${encodeURIComponent(playlistId)}`;
      const response = await fetchPlaylist(url, { signal: request.signal });
      if (!response.ok) return null;
      const playlist = parsePlaylist(await response.json(), baseUrl);
      return new Set(playlist.tracks.map((track) => track.id));
    } catch {
      // An optional curation list must not make the main playlist unavailable.
      return null;
    } finally {
      clearTimeout(deadline);
      parentSignal.removeEventListener('abort', cancel);
    }
  }

  function firstTrack(openingIds: Set<string> | null, secondIds: Set<string> | null): Readonly<Track> | undefined {
    const candidates = state.playlist?.tracks.filter((track) => openingIds?.has(track.id)) ?? [];
    let opening: Readonly<Track> | undefined;
    if (candidates.length) {
      opening = candidates[Math.floor(random() * candidates.length)]!;
      nextTrack(undefined, false);
      const openingId = opening.id;
      queue = queue.filter((track) => track.id !== openingId);
    } else {
      opening = nextTrack();
    }
    // Reserve the second selection now so next-song preloading uses the same
    // choice. Only the initial two slots are curated; later cycles stay normal.
    if (options.secondPlaylistId && opening) {
      const secondPool = queue.filter((track) => openingIds?.has(track.id) || secondIds?.has(track.id));
      if (secondPool.length) {
        const second = secondPool[Math.floor(random() * secondPool.length)]!;
        queue = [second, ...queue.filter((track) => track.id !== second.id)];
      }
    }
    return opening;
  }

  function prepare(): Promise<void> {
    if (disposed || prepared) return Promise.resolve();
    if (preparation) return preparation;
    preparation = (async () => {
      update({ status: 'loading', error: null });
      if (disposed) return;
      try {
        if (!audio) {
          audio = (options.audioFactory ?? (() => new Audio()))();
          audio.preload = 'auto';
          for (const [type, listener] of Object.entries(events)) audio.addEventListener(type, listener);
        }
        controller = new AbortController();
        const curated = Promise.all([
          curatedTrackIds(options.openingPlaylistId, controller.signal),
          curatedTrackIds(options.secondPlaylistId, controller.signal),
        ]);
        const response = await fetchPlaylist(endpoint, { signal: controller.signal });
        if (!response.ok) throw new Error(`Unable to load playlist (HTTP ${response.status}).`);
        const data: unknown = await response.json();
        if (disposed) return;
        const playlist = parsePlaylist(data, baseUrl);
        const [openingIds, secondIds] = await curated;
        if (disposed) return;
        prepared = true;
        update({ playlist });
        if (disposed) return;
        const track = firstTrack(openingIds, secondIds);
        if (!track) {
          cancelIntent();
          update({ status: 'empty', track: null, error: null });
          return;
        }
        selectTrack(track);
      } catch (error) { fail(error); }
      finally { controller?.abort(); controller = undefined; }
    })().finally(() => { preparation = undefined; });
    return preparation;
  }

  function play(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (desiredPlaying && state.status === 'playing') return Promise.resolve();
    if (desiredPlaying && playback?.command === command) return playback.promise;
    desiredPlaying = true;
    const version = ++command;
    const promise = prepared
      ? startPlayback(version)
      : prepare().then(() => startPlayback(version));
    playback = { command: version, promise };
    void promise.finally(() => { if (playback?.command === version) playback = undefined; });
    if (prepared && !state.track) cancelIntent();
    return promise;
  }

  function playNext(excludeTrackId = state.track?.id): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!prepared) return play();
    cancelIntent();
    audio?.pause();
    try {
      const track = nextTrack(excludeTrackId);
      if (!track) return Promise.resolve();
      selectTrack(track);
      return play();
    } catch (error) {
      fail(error);
      return Promise.resolve();
    }
  }

  function pause(): void {
    if (disposed) return;
    cancelIntent();
    audio?.pause();
    if (state.track && state.status !== 'error') update({ status: 'paused' });
  }

  return {
    get state() { return state; },
    prepare,
    play,
    playNext,
    pause,
    toggle() {
      if (desiredPlaying) { pause(); return Promise.resolve(); }
      return play();
    },
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      inform(listener);
      return () => { listeners.delete(listener); };
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      cancelIntent();
      controller?.abort();
      preloader.clear();
      if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = undefined;
      if (audio) {
        for (const [type, listener] of Object.entries(events)) audio.removeEventListener(type, listener);
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      queue = [];
      update({ status: 'destroyed', playlist: null, track: null, error: null });
      listeners.clear();
    },
  };
}
