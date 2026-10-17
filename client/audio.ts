import { createStreamPreloader } from './preload.js';
import type { AudioPlayer, PlaybackState, StreamTrack, TrackInfo } from './audio-types.js';
export type { AudioPlayer, PlaybackState, StreamTrack, TrackInfo } from './audio-types.js';

export interface AudioPlayerOptions {
  demoUrl?: string;
  initialTrack?: TrackInfo;
  audioFactory?: () => HTMLAudioElement;
  fetch?: typeof globalThis.fetch;
}

function streamUrl(track: StreamTrack): string {
  let url: URL;
  try { url = new URL(track.url); } catch { throw new Error('This recording has an invalid stream address.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('This recording has an invalid stream address.');
  }
  return url.href;
}

const DEMO_DURATION = 64;
const FADE_IN_MS = 300;
const FADE_OUT_MS = 200;


/** One persistent media element for local files, the demo, and cross-origin streams. */
export function createAudioPlayer(options: AudioPlayerOptions = {}): AudioPlayer {
  const audio = (options.audioFactory ?? (() => new Audio()))();
  const nativeOutput = typeof navigator !== 'undefined' && (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
  let restoreAudioSession: (() => void) | undefined;
  const configurePlaybackSession = () => {
    if (restoreAudioSession || typeof navigator === 'undefined') return;
    try {
      const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession;
      if (!session) return;
      const previous = session.type;
      session.type = 'playback';
      restoreAudioSession = () => { if (session.type === 'playback') session.type = previous; };
    } catch { /* Optional browser API. */ }
  };
  const preloader = createStreamPreloader(options.fetch ?? globalThis.fetch);
  audio.preload = 'metadata';
  audio.volume = .7;
  audio.crossOrigin = 'anonymous';
  audio.src = options.demoUrl ?? '/assets/demo-evening.wav';
  let disposed = false;
  let loading = false;
  let objectUrl: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelLoad: (() => void) | undefined;
  let context: AudioContext | undefined;
  let gain: GainNode | undefined;
  let unlocked = false;
  let priming = false;
  let preparation: Promise<void> | undefined;
  let sourceVersion = 0;
  let playVersion = 0;
  let wantsPlay = false;
  let fadePause: ReturnType<typeof setTimeout> | undefined;
  let fallbackFade: ReturnType<typeof setInterval> | undefined;
  let envelope: { from: number; to: number; started: number; duration: number } | undefined;
  let outputLevel = 0;
  let state: PlaybackState = {
    playing: false, position: 0, volume: .7, status: 'ready', error: null,
    track: options.initialTrack ? { ...options.initialTrack } : { title: 'Evening Reverie', artist: 'The Listening Room', duration: DEMO_DURATION, source: 'demo' },
  };
  const listeners = new Set<(state: PlaybackState) => void>();
  const snapshot = (): PlaybackState => ({ ...state, outputLevel: currentOutput(), track: { ...state.track } });
  const emit = () => {
    if (!disposed) listeners.forEach(listener => listener(snapshot()));
  };
  const stopTimer = () => { if (timer !== undefined) clearInterval(timer); timer = undefined; };
  const position = () => Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  const syncPosition = () => { if (!disposed && !loading && !priming) { state.position = position(); emit(); } };
  const setPlaying = (playing: boolean) => {
    if (disposed || loading || priming) return;
    state.playing = playing;
    if (state.status !== 'error' && state.status !== 'ended') state.status = playing ? 'playing' : 'paused';
    state.position = position();
    stopTimer();
    if (playing) timer = setInterval(syncPosition, 125);
    emit();
  };
  const outputTime = () => context ? context.currentTime * 1000 : performance.now();
  const eased = (progress: number) => progress * progress * (3 - 2 * progress);
  const currentOutput = () => {
    if (!envelope) return outputLevel;
    const progress = Math.max(0, Math.min(1, (outputTime() - envelope.started) / envelope.duration));
    return envelope.from + (envelope.to - envelope.from) * eased(progress);
  };
  const cancelFadePause = () => {
    if (fadePause !== undefined) clearTimeout(fadePause);
    fadePause = undefined;
  };
  const holdOutput = () => {
    const previousEnvelope = envelope;
    outputLevel = currentOutput();
    envelope = undefined;
    if (fallbackFade !== undefined) clearInterval(fallbackFade);
    fallbackFade = undefined;
    if (gain && context) {
      // AudioParam.value is not a reliable sample of a scheduled curve.
      // Sample our envelope before canceling so a rapid reversal stays continuous.
      if (typeof gain.gain.cancelAndHoldAtTime === 'function') {
        gain.gain.cancelAndHoldAtTime(context.currentTime);
      } else {
        // Cancel from the curve's start on older WebKit: canceling only
        // future events can leave an active curve overlapping the next ramp.
        gain.gain.cancelScheduledValues(previousEnvelope ? previousEnvelope.started / 1000 : context.currentTime);
      }
      gain.gain.setValueAtTime(outputLevel, context.currentTime);
    } else audio.volume = outputLevel;
    return outputLevel;
  };
  const silence = () => {
    cancelFadePause();
    holdOutput();
    outputLevel = 0;
    if (gain && context) gain.gain.setValueAtTime(0, context.currentTime);
    else { audio.volume = 0; audio.muted = true; }
  };
  const rampOutput = (target: number, duration: number) => {
    const from = holdOutput();
    if (nativeOutput) {
      // iOS may ignore volume writes. Muting is the reliable zero-output gate;
      // native output cannot promise the desktop graph's smooth envelope.
      outputLevel = target;
      audio.volume = target;
      audio.muted = target === 0;
      return;
    }
    envelope = { from, to: target, started: outputTime(), duration };
    if (gain && context) {
      const curve = new Float32Array(65);
      for (let i = 0; i < curve.length; i++) curve[i] = from + (target - from) * eased(i / (curve.length - 1));
      gain.gain.setValueCurveAtTime(curve, context.currentTime, duration / 1000);
    } else {
      // Older browsers use media volume; muting still guarantees silent priming
      // and teardown on platforms that ignore programmatic media volume.
      audio.muted = false;
      fallbackFade = setInterval(() => {
        audio.volume = currentOutput();
        if (envelope && outputTime() - envelope.started >= envelope.duration) {
          outputLevel = target;
          envelope = undefined;
          clearInterval(fallbackFade);
          fallbackFade = undefined;
        }
      }, 16);
    }
  };
  const openOutput = () => rampOutput(state.volume, FADE_IN_MS);
  const ensureOutput = () => {
    if (context) return;
    if (nativeOutput) { audio.muted = true; return; }
    const Context = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) { audio.muted = true; return; }
    context = new Context();
    gain = context.createGain();
    gain.gain.value = 0;
    context.createMediaElementSource(audio).connect(gain);
    gain.connect(context.destination);
    audio.volume = 1;
    // Loading may mute the media before this graph exists. The zeroed gain now
    // owns silence and fades, so the source must feed it unmuted audio.
    audio.muted = false;
  };
  const onPlaying = () => {
    if (disposed || (!wantsPlay && !priming)) { silence(); audio.pause(); return; }
    if (wantsPlay && !audio.paused) setPlaying(true);
  };
  const onWaiting = () => {
    if (!disposed && !loading && !priming && wantsPlay && !audio.paused) {
      state.status = 'buffering'; emit();
    }
  };
  const onPause = () => {
    if (audio.paused) {
      if (!loading && !priming) { wantsPlay = false; ++playVersion; }
      silence(); setPlaying(false);
    }
  };
  const onEnded = () => {
    if (disposed || loading || priming || state.status === 'ended') return;
    state.status = 'ended';
    wantsPlay = false;
    ++playVersion;
    silence();
    audio.currentTime = 0;
    setPlaying(false);
  };
  const onDuration = () => {
    if (disposed || loading || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    state.track.duration = audio.duration;
    emit();
  };
  const onError = () => { if (!disposed && !loading && !priming) { wantsPlay = false; ++playVersion; state.status = 'error'; state.error = 'This recording stopped playing. Check your connection and tap play to retry.'; silence(); audio.pause(); setPlaying(false); } };
  const handlers: [string, EventListener][] = [
    ['playing', onPlaying], ['waiting', onWaiting], ['pause', onPause], ['ended', onEnded],
    ['durationchange', onDuration], ['seeked', syncPosition], ['error', onError],
  ];
  handlers.forEach(([name, handler]) => audio.addEventListener(name, handler));

  const prepare = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('This player has been closed.'));
    if (loading) return Promise.reject(new Error('Please wait for the track to finish loading.'));
    try {
      // iOS stays on native media output for background reliability. load() can
      // activate this owner without ever starting audible speculative music.
      if (nativeOutput) {
        configurePlaybackSession();
        if (!unlocked && !wantsPlay && !state.playing) {
          const initialPosition = position();
          silence(); audio.load();
          try { audio.currentTime = initialPosition; } catch { /* Metadata may still be pending. */ }
          unlocked = true;
        }
        return Promise.resolve();
      }
      ensureOutput();
      // Both browser permissions must be requested before leaving the user gesture.
      const resumed = context?.resume() ?? Promise.resolve();
      if (preparation) { void resumed.catch(() => {}); return preparation; }
      if (unlocked || wantsPlay || state.playing) return resumed;
      silence();
      priming = true;
      const initialPosition = position();
      const version = sourceVersion;
      let started: Promise<void>;
      try { started = audio.play(); }
      catch (error) { started = Promise.reject(error); }
      const guardedStart = started.then(() => {
        if (disposed || (version !== sourceVersion && !wantsPlay) || (!priming && !wantsPlay)) {
          silence(); audio.pause();
        }
      });
      const pending = Promise.all([resumed, guardedStart]).then(() => {
        if (disposed || version !== sourceVersion) throw new Error('Playback preparation was canceled.');
        unlocked = true;
      }).finally(() => {
        try {
          if (disposed || (version !== sourceVersion && !wantsPlay)) {
            silence(); audio.pause();
          } else if (version === sourceVersion) {
            silence();
            audio.pause();
            audio.currentTime = initialPosition;
          }
        } finally {
          if (version === sourceVersion) priming = false;
          if (preparation === pending) preparation = undefined;
        }
      });
      preparation = pending;
      return pending;
    } catch (error) {
      silence();
      return Promise.reject(error);
    }
  };

  const loadSource = async (nextSource: string, track: TrackInfo, nextObjectUrl?: string): Promise<void> => {
    cancelLoad?.();
    ++sourceVersion;
    ++playVersion;
    wantsPlay = false;
    preparation = undefined;
    priming = false;
    const previousPosition = position();
    loading = true;
    state.status = 'loading'; state.error = null;
    silence();
    audio.pause();
    stopTimer();
    state.playing = false;
    state.position = 0;
    emit();
    if (disposed) {
      if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
      throw new Error('This player has been closed.');
    }
    const previousSource = audio.src;
    const previousTrack: TrackInfo = { ...state.track };
    const previousUrl = objectUrl;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const cleanup = () => {
        clearTimeout(timeout);
        audio.removeEventListener('loadedmetadata', success);
        audio.removeEventListener('error', failure);
        cancelLoad = undefined;
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (nextObjectUrl) URL.revokeObjectURL(nextObjectUrl);
        loading = false;
        if (!disposed) {
          audio.src = previousSource;
          state.track = previousTrack;
          state.status = 'error'; state.error = message;
          state.position = previousPosition;
          audio.load();
          try { audio.currentTime = previousPosition; } catch { /* Metadata may need to reload first. */ }
          emit();
        }
        reject(new Error(message));
      };
      const success = () => {
        if (settled || disposed) return;
        if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
          fail('This source does not contain a playable audio track.');
          return;
        }
        settled = true;
        cleanup();
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        objectUrl = nextObjectUrl;
        loading = false;
        state.track = { ...track, duration: audio.duration };
        state.status = 'ready'; state.error = null;
        state.position = 0;
        state.playing = false;
        emit();
        resolve();
      };
      const failure = () => fail(track.source === 'stream'
        ? 'This recording could not be streamed. Please try again.'
        : 'This audio format could not be played. Try an MP3, WAV, M4A, or OGG file.');
      cancelLoad = () => fail(disposed ? 'This player has been closed.' : 'A different track was selected.');
      timeout = setTimeout(() => fail('This audio source took too long to load. Please try again.'), 10000);
      audio.addEventListener('loadedmetadata', success);
      audio.addEventListener('error', failure);
      audio.crossOrigin = 'anonymous';
      audio.src = nextSource;
      audio.load();
    });
  };

  return {
    prepare,
    preloadStream(track) {
      if (disposed) return;
      try { preloader.preload(streamUrl(track)); } catch { preloader.clear(); }
    },
    async play() {
      if (disposed) throw new Error('This player has been closed.');
      if (loading) throw new Error('Please wait for the track to finish loading.');
      cancelFadePause();
      holdOutput();
      const version = ++playVersion;
      const source = sourceVersion;
      wantsPlay = true;
      try {
        if (preparation) await preparation;
        if (disposed || version !== playVersion || source !== sourceVersion) return;
        configurePlaybackSession();
        ensureOutput();
        state.status = 'buffering'; state.error = null; emit();
        if (disposed || version !== playVersion || source !== sourceVersion) return;
        // Request both permissions in this gesture; awaiting resume first can
        // lose native media activation in Safari.
        const resumed = context?.resume() ?? Promise.resolve();
        if (nativeOutput) { audio.volume = state.volume; audio.muted = state.volume === 0; }
        const started = audio.play().then(() => {
          // resume() may reject before play() settles; still cancel its late
          // completion so it cannot revive output after a failed request.
          if (disposed || (!wantsPlay && (version !== playVersion || source !== sourceVersion))) {
            silence(); audio.pause();
          }
        });
        await Promise.all([resumed, started]);
        if (disposed || version !== playVersion || source !== sourceVersion) {
          if (disposed || (source === sourceVersion && !wantsPlay && fadePause === undefined)) { silence(); audio.pause(); }
          return;
        }
        if (!audio.paused) { unlocked = true; openOutput(); setPlaying(true); }
      } catch (error) {
        if (!disposed && version === playVersion && source === sourceVersion) {
          wantsPlay = false;
          state.status = 'error';
          state.error = error instanceof Error ? error.message : 'Unable to play this recording. Tap play to retry.';
          silence();
          audio.pause();
          setPlaying(false);
        }
        throw error;
      }
    },
    pause(immediate = false) {
      if (disposed) return;
      if (!immediate && fadePause !== undefined) return;
      wantsPlay = false;
      ++playVersion;
      if (immediate || nativeOutput || audio.paused || !state.playing) {
        silence();
        audio.pause();
        setPlaying(false);
        return;
      }
      rampOutput(0, FADE_OUT_MS);
      const version = playVersion;
      fadePause = setTimeout(() => {
        fadePause = undefined;
        if (disposed || wantsPlay || version !== playVersion) return;
        silence();
        audio.pause();
        setPlaying(false);
      }, FADE_OUT_MS);
    },
    seek(seconds) {
      if (disposed || loading || priming || !Number.isFinite(seconds)) return;
      const target = Math.max(0, Math.min(seconds, state.track.duration));
      audio.currentTime = target;
      state.position = target;
      emit();
    },
    setVolume(volume) {
      if (disposed || !Number.isFinite(volume)) return;
      state.volume = Math.max(0, Math.min(1, volume));
      if (wantsPlay && state.playing) rampOutput(state.volume, 80);
      emit();
    },
    async loadFile(file) {
      if (disposed) throw new Error('This player has been closed.');
      if (!file.size) throw new Error('This audio file is empty.');
      preloader.clear();
      const nextUrl = URL.createObjectURL(file);
      const title = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled record';
      await loadSource(nextUrl, { title, artist: 'Your collection', duration: 0, source: 'file' }, nextUrl);
    },
    async loadStream(track: StreamTrack) {
      if (disposed) throw new Error('This player has been closed.');
      const url = streamUrl(track);
      const title = track.title.trim(), artist = track.artist.trim();
      if (!title || !artist || title.length > 250 || artist.length > 250 || /[\u0000-\u001f\u007f]/.test(title + artist)) {
        throw new Error('This recording has invalid title or artist information.');
      }
      const cached = preloader.take(url);
      const cachedUrl = cached ? URL.createObjectURL(cached) : undefined;
      await loadSource(cachedUrl ?? url, { title, artist, duration: track.duration && Number.isFinite(track.duration) && track.duration > 0 ? track.duration : 0, source: 'stream' }, cachedUrl);
    },
    getState: snapshot,
    subscribe(listener) {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(snapshot());
      return () => { listeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      preloader.clear();
      try { restoreAudioSession?.(); } catch { /* Optional browser API. */ }
      ++sourceVersion;
      ++playVersion;
      wantsPlay = false;
      silence();
      cancelLoad?.();
      stopTimer();
      audio.pause();
      state.playing = false;
      state.position = 0;
      handlers.forEach(([name, handler]) => audio.removeEventListener(name, handler));
      audio.removeAttribute('src');
      audio.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      listeners.clear();
      void context?.close().catch(() => {});
    },
  };
}
