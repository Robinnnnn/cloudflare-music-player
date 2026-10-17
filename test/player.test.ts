import assert from 'node:assert/strict';
import test from 'node:test';
import { createMusicPlayer, type MusicAudio, type MusicPlayerStatus } from '../client/player.js';
import type { Playlist } from '../src/types.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeAudio extends EventTarget implements MusicAudio {
  src = '';
  preload = '';
  paused = true;
  ended = false;
  error: { message: string } | null = null;
  currentTime = 0;
  playCalls = 0;
  loadCalls = 0;
  nextPlay: Promise<void> | undefined;

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    this.ended = false;
    if (this.nextPlay) {
      const pending = this.nextPlay;
      this.nextPlay = undefined;
      return pending;
    }
    this.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  }

  pause(): void {
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.dispatchEvent(new Event('pause'));
  }

  load(): void {
    this.loadCalls += 1;
    this.currentTime = 0;
    this.ended = false;
    this.error = null;
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }

  finish(): void {
    this.ended = true;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
    this.dispatchEvent(new Event('ended'));
  }

  breakFile(): void {
    this.error = { message: 'The audio file cannot be decoded.' };
    this.dispatchEvent(new Event('error'));
  }
}

const playlist: Playlist = {
  id: 'default', title: 'Classical', tracks: ['a', 'b', 'c'].map((id) => ({
    id, title: `Title ${id}`, artist: `Artist ${id}`, audioUrl: `https://music.example/v1/tracks/${id}/audio`,
  })),
};

function setup(data = playlist, random = () => 0.999) {
  const audio = new FakeAudio();
  let fetchCalls = 0;
  let audioInstances = 0;
  const player = createMusicPlayer({
    baseUrl: 'https://music.example/', random,
    audioFactory: () => { audioInstances += 1; return audio; },
    fetch: async (input) => {
      fetchCalls += 1;
      assert.equal(input, 'https://music.example/v1/playlists/default');
      return Response.json(data);
    },
  });
  return { player, audio, get fetchCalls() { return fetchCalls; }, get audioInstances() { return audioInstances; } };
}

test('prepare shares one request and preloads without autoplay; pause/resume preserves position', async () => {
  const fixture = setup();
  const { player, audio } = fixture;
  const statuses: MusicPlayerStatus[] = [];
  const unsubscribe = player.subscribe((state) => statuses.push(state.status));
  assert.deepEqual(statuses, ['idle']);
  await Promise.all([player.prepare(), player.prepare()]);
  assert.equal(fixture.fetchCalls, 1);
  assert.equal(fixture.audioInstances, 1);
  assert.equal(audio.preload, 'auto');
  assert.equal(audio.playCalls, 0);
  assert.equal(player.state.status, 'ready');
  assert.equal(audio.src, player.state.track?.audioUrl);
  assert.equal(player.state.track?.title, 'Title a');

  const starting = player.play();
  assert.equal(audio.playCalls, 1, 'prepared playback calls audio.play synchronously in the gesture');
  await starting;
  assert.equal(player.state.status, 'playing');
  audio.currentTime = 17;
  await player.toggle();
  assert.equal(player.state.status, 'paused');
  assert.equal(audio.currentTime, 17);
  await player.toggle();
  assert.equal(player.state.status, 'playing');
  assert.equal(audio.currentTime, 17);
  assert.equal(audio.loadCalls, 1);
  unsubscribe();
  const notifications = statuses.length;
  player.pause();
  assert.equal(statuses.length, notifications);
  player.destroy();
});

test('each client has an independent queue; every cycle includes all tracks with no boundary repeat', async () => {
  const first = setup(playlist, () => 0);
  const second = setup(playlist, () => 0.999);
  await Promise.all([first.player.prepare(), second.player.prepare()]);
  assert.notEqual(first.player.state.track?.id, second.player.state.track?.id);
  await first.player.play();
  const ids: string[] = [];
  for (let index = 0; index < 12; index += 1) {
    ids.push(first.player.state.track!.id);
    first.audio.finish();
    await Promise.resolve();
  }
  for (let start = 0; start < ids.length; start += 3) {
    assert.deepEqual([...ids.slice(start, start + 3)].sort(), ['a', 'b', 'c']);
  }
  for (let index = 1; index < ids.length; index += 1) assert.notEqual(ids[index], ids[index - 1]);
  assert.equal(second.audio.playCalls, 0);
  assert.equal(second.player.state.track?.id, 'a');
  first.player.destroy();
  second.player.destroy();
});

test('a single-track playlist repeats at its end and an empty playlist remains usefully empty', async () => {
  const single = setup({ ...playlist, tracks: playlist.tracks.slice(0, 1) });
  await single.player.play();
  single.audio.finish();
  await Promise.resolve();
  assert.equal(single.audio.playCalls, 2);
  assert.equal(single.player.state.track?.id, 'a');
  single.player.destroy();

  const empty = setup({ ...playlist, tracks: [] });
  await empty.player.play();
  await empty.player.toggle();
  assert.equal(empty.player.state.status, 'empty');
  assert.equal(empty.player.state.track, null);
  assert.equal(empty.audio.playCalls, 0);
  empty.player.destroy();
});

test('native playback events report actual playback and external pauses stop advancement', async () => {
  const { player, audio } = setup();
  await player.prepare();
  const pending = deferred<void>();
  audio.nextPlay = pending.promise;
  const playing = player.play();
  assert.equal(player.state.status, 'buffering');
  pending.resolve();
  await playing;
  assert.equal(player.state.status, 'buffering', 'resolved play promise alone is not a playing event');
  audio.dispatchEvent(new Event('playing'));
  assert.equal(player.state.status, 'playing');
  audio.dispatchEvent(new Event('waiting'));
  assert.equal(player.state.status, 'buffering');
  audio.pause();
  assert.equal(player.state.status, 'paused');
  const track = player.state.track;
  audio.finish();
  assert.equal(player.state.track, track);
  player.destroy();
});

test('pause cancels pending play, and a late rejection cannot replace paused state', async () => {
  const { player, audio } = setup();
  await player.prepare();
  const pending = deferred<void>();
  audio.nextPlay = pending.promise;
  const starting = player.play();
  player.pause();
  await starting;
  pending.reject(new Error('Interrupted by pause'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.state.status, 'paused');
  assert.equal(audio.paused, true);
  await player.play();
  assert.equal(player.state.status, 'playing');
  player.destroy();
});

test('an early click can be canceled during preparation without starting audio', async () => {
  const response = deferred<Response>();
  const audio = new FakeAudio();
  const player = createMusicPlayer({
    baseUrl: 'https://music.example', audioFactory: () => audio, fetch: () => response.promise,
  });
  const starting = player.play();
  player.pause();
  response.resolve(Response.json(playlist));
  await starting;
  assert.equal(audio.playCalls, 0);
  assert.equal(player.state.status, 'ready');
  await player.play();
  assert.equal(player.state.status, 'playing');
  player.destroy();
});

test('fetch failures can be retried, and invalid catalog data is not playable', async () => {
  const audio = new FakeAudio();
  let attempts = 0;
  const player = createMusicPlayer({
    baseUrl: 'https://music.example', audioFactory: () => audio,
    fetch: async () => ++attempts === 1 ? new Response('', { status: 503 }) : Response.json(playlist),
  });
  await player.play();
  assert.equal(player.state.status, 'error');
  assert.match(player.state.error!, /503/);
  await player.play();
  assert.equal(player.state.status, 'playing');
  player.destroy();

  const invalid = setup({ ...playlist, tracks: [playlist.tracks[0]!, playlist.tracks[0]!] });
  await invalid.player.play();
  assert.equal(invalid.player.state.status, 'error');
  assert.match(invalid.player.state.error!, /Duplicate track ID/);
  assert.equal(invalid.audio.playCalls, 0);
  invalid.player.destroy();
});

test('audio and play failures stop without skipping or retry loops, then permit explicit retry', async () => {
  const { player, audio } = setup();
  await player.prepare();
  const firstTrack = player.state.track;
  audio.nextPlay = Promise.reject(new Error('A user gesture is required.'));
  await player.play();
  assert.equal(player.state.status, 'error');
  assert.match(player.state.error!, /gesture/);
  assert.equal(audio.playCalls, 1);
  assert.equal(player.state.track, firstTrack);
  await player.play();
  assert.equal(player.state.status, 'playing');
  audio.breakFile();
  assert.equal(player.state.status, 'error');
  assert.equal(audio.paused, true);
  assert.equal(audio.playCalls, 2);
  assert.equal(player.state.track, firstTrack);
  await player.play();
  assert.equal(player.state.status, 'playing');
  player.destroy();
});

test('destroy aborts preparation, clears the audio source, and ignores late fetch completion', async () => {
  const response = deferred<Response>();
  const audio = new FakeAudio();
  let signal: AbortSignal | undefined;
  const player = createMusicPlayer({
    baseUrl: 'https://music.example', audioFactory: () => audio,
    fetch: (_input, init) => { signal = init?.signal ?? undefined; return response.promise; },
  });
  const preparing = player.prepare();
  player.destroy();
  assert.equal(signal?.aborted, true);
  response.resolve(Response.json(playlist));
  await preparing;
  assert.equal(player.state.status, 'destroyed');
  assert.equal(player.state.track, null);
  assert.equal(audio.src, '');
  await player.play();
  await player.prepare();
  assert.equal(audio.playCalls, 0);
});

test('destroy cancels pending playback and detached media events cannot resurrect the player', async () => {
  const { player, audio } = setup();
  await player.prepare();
  const pending = deferred<void>();
  audio.nextPlay = pending.promise;
  const starting = player.play();
  player.destroy();
  await starting;
  audio.paused = false;
  pending.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(audio.paused, true);
  audio.dispatchEvent(new Event('playing'));
  audio.finish();
  audio.breakFile();
  assert.equal(player.state.status, 'destroyed');
  assert.equal(player.state.track, null);
  assert.equal(audio.src, '');
  assert.equal(audio.playCalls, 1);
  player.destroy();
});

test('a consumer can dispose from a state notification without loading or starting more audio', async () => {
  const catalogLoaded = setup();
  catalogLoaded.player.subscribe((state) => { if (state.playlist) catalogLoaded.player.destroy(); });
  await catalogLoaded.player.prepare();
  assert.equal(catalogLoaded.player.state.status, 'destroyed');
  assert.equal(catalogLoaded.player.state.playlist, null);
  assert.equal(catalogLoaded.audio.src, '');

  const loading = setup();
  loading.player.subscribe((state) => { if (state.status === 'loading') loading.player.destroy(); });
  await loading.player.prepare();
  assert.equal(loading.player.state.status, 'destroyed');
  assert.equal(loading.audioInstances, 0);
  assert.equal(loading.fetchCalls, 0);

  const ready = setup();
  ready.player.subscribe((state) => { if (state.status === 'ready') ready.player.destroy(); });
  await ready.player.play();
  assert.equal(ready.player.state.status, 'destroyed');
  assert.equal(ready.audio.src, '');
  assert.equal(ready.audio.playCalls, 0);

  const buffering = setup();
  await buffering.player.prepare();
  buffering.player.subscribe((state) => { if (state.status === 'buffering') buffering.player.pause(); });
  await buffering.player.play();
  assert.equal(buffering.player.state.status, 'paused');
  assert.equal(buffering.audio.playCalls, 0);
  buffering.player.destroy();
});

test('playNext advances the shuffle synchronously and never repeats across cycles', async () => {
  const { player, audio } = setup();
  await player.prepare();
  await player.play();
  const ids = [player.state.track!.id];
  for (let i = 0; i < 9; i++) {
    audio.currentTime = 17;
    player.pause();
    assert.equal(player.state.track!.id, ids.at(-1), 'pausing retains metadata');
    const calls = audio.playCalls;
    const next = player.playNext();
    assert.equal(audio.playCalls, calls + 1, 'play stays in the tap gesture');
    assert.equal(audio.currentTime, 0);
    assert.notEqual(player.state.track!.id, ids.at(-1));
    ids.push(player.state.track!.id);
    await next;
  }
  for (let i = 0; i < 9; i += 3) assert.deepEqual(ids.slice(i, i + 3).sort(), ['a', 'b', 'c']);
  player.destroy();
});

test('playNext excludes closing metadata even if an ended event already advanced internally', async () => {
  const { player, audio } = setup();
  await player.play();
  audio.finish();
  await player.playNext('c');
  assert.notEqual(player.state.track!.id, 'c', 'even the sole queued track can be excluded');
  await player.playNext('a');
  assert.notEqual(player.state.track!.id, 'a');
  player.destroy();
});

test('playNext cancels pending playback and ignores its late rejection', async () => {
  const { player, audio } = setup();
  await player.prepare();
  const pending = deferred<void>();
  audio.nextPlay = pending.promise;
  const old = player.play();
  await player.playNext();
  await old;
  pending.reject(new Error('Old audio load interrupted'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.track!.id, 'b');
  player.destroy();
});

test('playNext handles unprepared, empty, single-track, and destroyed players', async () => {
  const single = setup({ ...playlist, tracks: playlist.tracks.slice(0, 1) });
  await single.player.playNext();
  single.audio.currentTime = 17;
  await single.player.playNext();
  assert.equal(single.audio.currentTime, 0);
  assert.equal(single.player.state.status, 'playing');
  single.player.destroy();
  await single.player.playNext();
  assert.equal(single.player.state.status, 'destroyed');
  const empty = setup({ ...playlist, tracks: [] });
  await empty.player.prepare();
  await empty.player.playNext();
  assert.equal(empty.player.state.status, 'empty');
  assert.equal(empty.audio.playCalls, 0);
  empty.player.destroy();
});

const settlePreload = async () => {
  // Response.blob() settles on the next event-loop turn in Node.
  await new Promise<void>((resolve) => setImmediate(resolve));
};

function preloadingSetup(load: (url: string, signal: AbortSignal) => Promise<Response> = async () => new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } })) {
  const audio = new FakeAudio();
  const requests: { url: string; signal: AbortSignal }[] = [];
  const player = createMusicPlayer({
    baseUrl: 'https://music.example', random: () => 0.999, preloadNext: true,
    audioFactory: () => audio,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/playlists/default')) return Response.json(playlist);
      const signal = init!.signal as AbortSignal;
      requests.push({ url, signal });
      return load(url, signal);
    },
  });
  return { player, audio, requests };
}

test('preloads only the next shuffle selection without changing metadata or playing it', async () => {
  const { player, audio, requests } = preloadingSetup();
  await player.prepare();
  assert.equal(requests.length, 0, 'initial audio loads before speculative downloads');
  await player.play();
  await settlePreload();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, playlist.tracks[1]!.audioUrl);
  assert.equal(player.state.track!.id, 'a');
  assert.equal(audio.playCalls, 1);
  player.pause();
  assert.equal(player.state.track!.id, 'a');
  const opening = player.playNext();
  assert.equal(audio.playCalls, 2, 'cached playback stays synchronous in the gesture');
  assert.match(audio.src, /^blob:/);
  assert.equal(player.state.track!.id, 'b');
  assert.equal(await (await fetch(audio.src)).text(), 'audio');
  await opening;
  await settlePreload();
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.url, playlist.tracks[2]!.audioUrl);
  const oldUrl = audio.src;
  await player.playNext();
  await assert.rejects(fetch(oldUrl), 'old recording memory is released on replacement');
  const activeUrl = audio.src;
  player.destroy();
  await assert.rejects(fetch(activeUrl), 'active recording memory is released on destroy');
  assert.equal(requests.at(-1)!.signal.aborted, true);
});

test('a pending preload never blocks a quick skip and its late response cannot replace newer audio', async () => {
  const pending = deferred<Response>();
  const { player, audio, requests } = preloadingSetup(async () => pending.promise);
  await player.play();
  await player.playNext();
  assert.equal(audio.src, playlist.tracks[1]!.audioUrl, 'unfinished preload falls back to streaming');
  assert.equal(requests[0]!.signal.aborted, true);
  const src = audio.src;
  pending.resolve(new Response('late audio'));
  await settlePreload();
  assert.equal(audio.src, src);
  assert.equal(player.state.status, 'playing');
  player.destroy();
});

test('failed speculative downloads do not affect playback or skipping', async () => {
  const { player, audio } = preloadingSetup(async () => new Response('', { status: 503 }));
  await player.play();
  await settlePreload();
  assert.equal(player.state.status, 'playing');
  assert.equal(player.state.error, null);
  await player.playNext();
  assert.equal(audio.src, playlist.tracks[1]!.audioUrl);
  assert.equal(player.state.status, 'playing');
  player.destroy();
});

test('natural advancement also uses the prepared song and continues preloading one ahead', async () => {
  const { player, audio, requests } = preloadingSetup();
  await player.play();
  await settlePreload();
  audio.finish();
  assert.equal(player.state.track!.id, 'b');
  assert.match(audio.src, /^blob:/);
  await settlePreload();
  assert.equal(requests.length, 2);
  player.destroy();
});

function openingSetup(opening: Playlist | number = { ...playlist, id: 'good-first-songs', tracks: [playlist.tracks[0]!] }, random = () => 0.999) {
  const audio = new FakeAudio();
  const requests: string[] = [];
  const player = createMusicPlayer({
    baseUrl: 'https://music.example', openingPlaylistId: 'good-first-songs', random,
    audioFactory: () => audio,
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith('/good-first-songs')
        ? typeof opening === 'number' ? new Response('', { status: opening }) : Response.json(opening)
        : Response.json(playlist);
    },
  });
  return { player, audio, requests };
}

test('curated opening is followed by the full shuffle without replaying the opener in that cycle', async () => {
  const { player, audio, requests } = openingSetup({ ...playlist, id: 'good-first-songs', tracks: [playlist.tracks[2]!] });
  await player.prepare();
  assert.equal(player.state.track!.id, 'c');
  assert.equal(audio.playCalls, 0);
  await player.play();
  player.pause();
  await player.play();
  assert.equal(player.state.track!.id, 'c', 'ordinary pause/resume retains the selected opener');
  const ids = [player.state.track!.id];
  await player.playNext();
  ids.push(player.state.track!.id);
  audio.finish();
  ids.push(player.state.track!.id);
  assert.deepEqual(ids, ['c', 'a', 'b']);
  assert.equal(requests.length, 2, 'opening catalog is fetched once per player');
  player.destroy();
});

test('opening selection is random among eligible main-playlist songs only', async () => {
  for (const [random, expected] of [[0, 'a'], [0.49, 'a'], [0.999, 'c']] as const) {
    const extra = { ...playlist.tracks[0]!, id: 'outside', audioUrl: 'https://music.example/outside.mp3' };
    const { player } = openingSetup({ ...playlist, tracks: [playlist.tracks[0]!, playlist.tracks[2]!, extra] }, () => random);
    await player.prepare();
    assert.equal(player.state.track!.id, expected);
    assert.equal(player.state.playlist!.tracks.length, 3);
    player.destroy();
  }
});

test('empty, missing, invalid, or non-overlapping opening lists fall back to normal shuffle', async () => {
  for (const opening of [404, 503, { ...playlist, tracks: [] }, { ...playlist, tracks: [playlist.tracks[0]!, playlist.tracks[0]!] }, { ...playlist, tracks: [{ ...playlist.tracks[0]!, id: 'outside' }] }]) {
    const { player } = openingSetup(opening);
    await player.play();
    assert.equal(player.state.status, 'playing');
    assert.equal(player.state.track!.id, 'a');
    player.destroy();
  }
});

test('a stalled opening list times out without blocking music; disposal cancels both preparations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const dispose of [false, true]) {
    const audio = new FakeAudio();
    let openerSignal: AbortSignal | undefined;
    const player = createMusicPlayer({
      baseUrl: 'https://music.example', openingPlaylistId: 'good-first-songs', audioFactory: () => audio,
      fetch: async (input, init) => {
        if (String(input).endsWith('/default')) return Response.json(playlist);
        openerSignal = init!.signal as AbortSignal;
        return new Promise<Response>((_, reject) => openerSignal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
      },
    });
    const pending = player.prepare();
    if (dispose) player.destroy();
    else t.mock.timers.tick(2000);
    await pending;
    assert.equal(openerSignal!.aborted, true);
    assert.equal(player.state.status, dispose ? 'destroyed' : 'ready');
    assert.equal(audio.playCalls, 0);
    player.destroy();
  }
});

function tierSetup(firstIds: string[], secondIds: string[], random = () => 0.999, preloadNext = false) {
  const data = { ...playlist, tracks: [...playlist.tracks, { ...playlist.tracks[0]!, id: 'd', audioUrl: 'https://music.example/d.mp3' }] };
  const audio = new FakeAudio();
  const downloads: string[] = [];
  const player = createMusicPlayer({
    baseUrl: 'https://music.example', openingPlaylistId: 'first', secondPlaylistId: 'second', random, preloadNext,
    audioFactory: () => audio,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/default')) return Response.json(data);
      if (url.endsWith('/first') || url.endsWith('/second')) {
        const ids = url.endsWith('/first') ? firstIds : secondIds;
        return Response.json({ ...data, tracks: data.tracks.filter(t => ids.includes(t.id)) });
      }
      downloads.push(url);
      return new Response('audio', { headers: { 'Content-Type': 'audio/mpeg' } });
    },
  });
  return { player, audio, downloads };
}

test('second selection includes unplayed first-tier favorites and deduplicates overlapping tiers', async () => {
  for (const second of [['c'], ['a', 'b', 'c']]) {
    const { player } = tierSetup(['a', 'b'], second, () => 0);
    await player.prepare();
    assert.equal(player.state.track!.id, 'a');
    await player.playNext();
    assert.equal(player.state.track!.id, 'b', 'unused first-tier song remains eligible');
    player.destroy();
  }
});

test('second choice expands to tier two; subsequent songs and cycles use full shuffle', async () => {
  const { player, audio } = tierSetup(['a', 'b'], ['c']);
  await player.play();
  const ids = [player.state.track!.id];
  audio.finish(); ids.push(player.state.track!.id);
  await player.playNext(); ids.push(player.state.track!.id);
  await player.playNext(); ids.push(player.state.track!.id);
  assert.deepEqual(ids, ['b', 'c', 'a', 'd']);
  await player.playNext();
  assert.equal(player.state.track!.id, 'a');
  await player.playNext();
  assert.equal(player.state.track!.id, 'b', 'new cycles are ordinary shuffle');
  player.destroy();
});

test('preloading uses the reserved cumulative second choice', async () => {
  const { player, audio, downloads } = tierSetup(['a', 'b'], ['c'], () => 0.999, true);
  await player.play();
  await settlePreload();
  assert.equal(downloads[0], playlist.tracks[2]!.audioUrl);
  await player.playNext();
  assert.equal(player.state.track!.id, 'c');
  assert.match(audio.src, /^blob:/);
  player.destroy();
});

test('empty or exhausted tiers fall back without repeats or losing main-playlist songs', async () => {
  for (const [first, second] of [[[], ['c']], [['a'], ['a']], [[], []]]) {
    const { player } = tierSetup(first!, second!);
    await player.prepare();
    const ids = [player.state.track!.id];
    await player.playNext(); ids.push(player.state.track!.id);
    if (!first!.length && second!.length) assert.equal(ids[1], 'c');
    for (let i = 0; i < 2; i++) { await player.playNext(); ids.push(player.state.track!.id); }
    assert.equal(new Set(ids).size, 4);
    player.destroy();
  }
});
