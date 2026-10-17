import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPlayer, type AudioPlayerOptions } from '../client/audio.ts';

class FakeAudio extends EventTarget {
  static instances: FakeAudio[] = [];
  preload = ''; volume = 1; muted = false; crossOrigin: string | null = null;
  currentTime = 0; duration = NaN; paused = true;
  assignments: { url: string; crossOrigin: string | null }[] = [];
  playCompletion?: Promise<void>;
  playCalls = 0;
  private url = '';
  constructor() { super(); FakeAudio.instances.push(this); }
  get src() { return this.url; }
  set src(url: string) { this.url = url; this.assignments.push({ url, crossOrigin: this.crossOrigin }); this.duration = NaN; this.currentTime = 0; }
  load() {}
  async play() { this.playCalls++; this.paused = false; if (this.playCompletion) await this.playCompletion; }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  removeAttribute() { this.url = ''; }
  ready(duration = 180) { this.duration = duration; this.dispatchEvent(new Event('loadedmetadata')); }
}

function fixture(t: TestContext, options: AudioPlayerOptions = {}) {
  const originals = ['Audio', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'Audio', { configurable: true, value: FakeAudio });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  const player = createAudioPlayer(options);
  t.after(() => {
    player.dispose();
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { player, audio: FakeAudio.instances.at(-1)! };
}
const track = (title = 'A recording') => ({ url: `https://music.example.com/v1/tracks/a-recording/audio`, title, artist: 'A singer' });

test('loads a stream on the existing media owner with CORS set before src', async t => {
  const count = FakeAudio.instances.length;
  const { player, audio } = fixture(t);
  const loaded = player.loadStream(track());
  await assert.rejects(player.prepare(), /finish loading/);
  audio.ready(204); await loaded;
  assert.equal(FakeAudio.instances.length, count + 1);
  assert.deepEqual(audio.assignments.at(-1), { url: track().url, crossOrigin: 'anonymous' });
  assert.deepEqual(player.getState().track, { title: track().title, artist: track().artist, duration: 204, source: 'stream' });
  assert.equal(player.getState().playing, false);
  assert.equal(audio.paused, true);
  await player.prepare();
  assert.equal(audio.paused, true, 'gesture preparation primes silently and returns to pause');
  await player.play();
  assert.equal(player.getState().playing, true);
  player.seek(999);
  assert.equal(audio.currentTime, 204);
  player.pause(true);
  assert.equal(player.getState().playing, false);
});

test('replacement cancels a pending stream and only accepts the new metadata', async t => {
  const { player, audio } = fixture(t);
  const first = player.loadStream(track('First'));
  const rejected = assert.rejects(first, /different track/);
  const second = player.loadStream(track('Second'));
  audio.ready(123);
  await Promise.all([rejected, second]);
  assert.equal(player.getState().track.title, 'Second');
  assert.equal(player.getState().track.duration, 123);
});

test('stream failure restores the previous file and retains its object URL', async t => {
  const { player, audio } = fixture(t);
  const revoked: string[] = [];
  t.mock.method(URL, 'createObjectURL', () => 'blob:local-file');
  t.mock.method(URL, 'revokeObjectURL', (url: string) => { revoked.push(url); });
  const local = player.loadFile(new File(['audio'], 'My_song.mp3'));
  audio.ready(90); await local;
  const failed = player.loadStream(track());
  const rejection = assert.rejects(failed, /could not be streamed/);
  audio.dispatchEvent(new Event('error')); await rejection;
  assert.equal(audio.src, 'blob:local-file');
  assert.equal(player.getState().track.title, 'My song');
  assert.equal(player.getState().track.source, 'file');
  assert.deepEqual(revoked, []);
  const successful = player.loadStream(track());
  audio.ready(); await successful;
  assert.deepEqual(revoked, ['blob:local-file']);
});

test('loading a local file cancels a stream and keeps local playback behavior', async t => {
  const { player, audio } = fixture(t);
  t.mock.method(URL, 'createObjectURL', () => 'blob:replacement');
  t.mock.method(URL, 'revokeObjectURL', () => {});
  const stream = player.loadStream(track());
  const rejected = assert.rejects(stream, /different track/);
  const local = player.loadFile(new File(['audio'], 'Replacement.wav'));
  audio.ready(40); await Promise.all([local, rejected]);
  assert.equal(player.getState().track.source, 'file');
  assert.equal(audio.src, 'blob:replacement');
});

test('disposal cancels loading and late metadata cannot revive the player', async t => {
  const { player, audio } = fixture(t);
  const loading = player.loadStream(track());
  const rejected = assert.rejects(loading, /closed/);
  player.dispose();
  audio.ready(); await rejected;
  assert.equal(audio.src, '');
  assert.equal(player.getState().playing, false);
  await assert.rejects(player.loadStream(track()), /closed/);
});

test('source replacement invalidates a late gesture preparation completion', async t => {
  const { player, audio } = fixture(t);
  let resolve!: () => void;
  audio.playCompletion = new Promise<void>(ok => { resolve = ok; });
  const preparation = player.prepare();
  const rejected = assert.rejects(preparation, /canceled/);
  const stream = player.loadStream(track());
  audio.ready(); await stream;
  resolve(); await rejected;
  assert.equal(player.getState().playing, false);
  assert.equal(player.getState().track.source, 'stream');
  assert.equal(audio.paused, true);
});

test('unsafe stream addresses and invalid metadata leave the current source intact', async t => {
  const { player, audio } = fixture(t);
  const original = audio.src;
  for (const url of ['javascript:alert(1)', 'data:audio/mpeg,abc', 'https://user:secret@example.com/track']) {
    await assert.rejects(player.loadStream({ ...track(), url }), /invalid stream/);
  }
  await assert.rejects(player.loadStream({ ...track(), title: '\u0000bad' }), /invalid title/);
  assert.equal(audio.src, original);
});

test('stream loading mute is cleared when the silent Web Audio output is connected', async t => {
  const { player, audio } = fixture(t);
  const gainParam = {
    value: 0,
    cancelScheduledValues() {},
    setValueAtTime(value: number) { this.value = value; },
    setValueCurveAtTime() {},
  };
  let connected = false;
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return { gain: gainParam, connect() { connected = true; } }; }
    createMediaElementSource() { return { connect() {} }; }
    async resume() {}
    async close() {}
  }
  Object.assign(window, { AudioContext: FakeAudioContext });
  const loaded = player.loadStream(track());
  audio.ready();
  await loaded;
  assert.equal(audio.muted, true, 'loading silences the media element before the output exists');
  await player.prepare();
  assert.equal(connected, true);
  assert.equal(gainParam.value, 0, 'priming remains silent through the connected gain');
  assert.equal(audio.muted, false, 'Web Audio receives unmuted media after loading');
  await player.play();
  assert.equal(audio.paused, false);
  assert.equal(audio.muted, false, 'playback can reach the speakers');
  assert.equal(audio.volume, 1);
  player.pause(true);
  assert.equal(gainParam.value, 0, 'immediate pause still silences the output');
});

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('completed speculative audio is consumed by the same owner and revoked on replacement', async t => {
  const count = FakeAudio.instances.length;
  const { player, audio } = fixture(t, { fetch: async () => new Response('cached audio') });
  player.preloadStream(track());
  await settle();
  assert.equal(player.getState().track.source, 'demo');
  assert.equal(audio.playCalls, 0);
  const load = player.loadStream(track());
  const cachedUrl = audio.src;
  assert.match(cachedUrl, /^blob:/);
  assert.equal(await (await fetch(cachedUrl)).text(), 'cached audio');
  audio.ready(); await load;
  assert.equal(FakeAudio.instances.length, count + 1);
  const replacement = player.loadStream({ ...track(), url: 'https://music.example/next' });
  audio.ready(); await replacement;
  await assert.rejects(fetch(cachedUrl));
});

test('unfinished, replaced, failed, and disposed speculative downloads never take over playback', async t => {
  const requests: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const { player, audio } = fixture(t, { fetch: async (_url, init) => new Promise<Response>(resolve => {
    requests.push({ signal: init!.signal as AbortSignal, resolve });
  }) });
  player.preloadStream(track()); await settle();
  const other = { ...track(), url: 'https://music.example/other' };
  player.preloadStream(other); await settle();
  assert.equal(requests[0]!.signal.aborted, true);
  requests[0]!.resolve(new Response('stale'));
  const load = player.loadStream(other);
  assert.equal(audio.src, other.url, 'pending speculative fetch falls back immediately');
  assert.equal(requests[1]!.signal.aborted, true);
  audio.ready(); await load;
  requests[1]!.resolve(new Response('late')); await settle();
  assert.equal(audio.src, other.url);
  player.preloadStream(track()); await settle();
  requests[2]!.resolve(new Response('', { status: 503 })); await settle();
  assert.equal(player.getState().error, null);
  const failed = player.loadStream(track());
  assert.equal(audio.src, track().url);
  audio.ready(); await failed;
  player.preloadStream(other); await settle();
  player.dispose();
  assert.equal(requests[3]!.signal.aborted, true);
  requests[3]!.resolve(new Response('disposed')); await settle();
  assert.equal(audio.src, '');
});

test('unsafe speculative URLs never fetch and do not change the current recording', async t => {
  let fetched = false;
  const { player, audio } = fixture(t, { fetch: async () => { fetched = true; return new Response('bad'); } });
  const original = audio.src;
  for (const url of ['javascript:bad', 'https://user:secret@example.com/audio']) player.preloadStream({ ...track(), url });
  await settle();
  assert.equal(fetched, false);
  assert.equal(audio.src, original);
});

test('waiting, playing, and live errors report status while retaining metadata and position', async t => {
  const { player, audio } = fixture(t);
  const load = player.loadStream(track());
  assert.equal(player.getState().status, 'loading');
  audio.ready(); await load;
  assert.equal(player.getState().status, 'ready');
  await player.play(); player.seek(37);
  audio.dispatchEvent(new Event('waiting'));
  assert.equal(player.getState().status, 'buffering');
  audio.dispatchEvent(new Event('playing'));
  assert.equal(player.getState().status, 'playing');
  audio.dispatchEvent(new Event('error'));
  assert.equal(player.getState().status, 'error');
  assert.match(player.getState().error!, /connection.*tap play/i);
  assert.equal(player.getState().position, 37);
  assert.equal(player.getState().track.title, track().title);
  assert.equal(audio.paused, true);
  assert.equal(audio.muted, true);
});

test('iPhone and desktop-mode iPad retain native output, never prime music, and restore audio sessions', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else Reflect.deleteProperty(globalThis, 'navigator'); });
  for (const device of [{ userAgent: 'iPhone', platform: 'iPhone', maxTouchPoints: 1 }, { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 }]) {
    const session = { type: 'auto' };
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { ...device, audioSession: session } });
    const { player, audio } = fixture(t);
    Object.assign(window, { AudioContext: class { constructor() { throw new Error('iOS must never connect Web Audio'); } } });
    audio.currentTime = 23;
    await player.prepare();
    assert.equal(audio.currentTime, 23);
    assert.equal(audio.playCalls, 0);
    assert.equal(audio.muted, true);
    assert.equal(session.type, 'playback');
    const play = player.play();
    assert.equal(audio.playCalls, 1, 'native play stays in the original gesture');
    assert.equal(audio.muted, false, 'explicit playback opens native output before play');
    assert.equal(session.type, 'playback');
    await play;
    player.setVolume(0);
    assert.equal(audio.muted, true, 'zero volume silences even devices that ignore volume writes');
    player.setVolume(.7);
    assert.equal(audio.muted, false);
    player.pause();
    assert.equal(audio.paused, true, 'native pause is immediate even if volume is ignored');
    assert.equal(audio.muted, true);
    player.dispose();
    assert.equal(session.type, 'auto');
  }
});

test('canceling or disposing a pending play cannot produce late playback', async t => {
  for (const dispose of [false, true]) {
    const { player, audio } = fixture(t);
    let resolve!: () => void;
    audio.playCompletion = new Promise<void>(ok => { resolve = ok; });
    const play = player.play();
    if (dispose) player.dispose(); else player.pause(true);
    resolve(); await play;
    assert.equal(audio.paused, true);
    assert.equal(audio.muted, true);
    assert.equal(player.getState().playing, false);
  }
});

test('a late media start is silenced even when AudioContext resume rejected first', async t => {
  const { player, audio } = fixture(t);
  class FailedContext {
    currentTime = 0; destination = {};
    createGain() { return { gain: { value: 0, cancelScheduledValues() {}, setValueAtTime() {}, setValueCurveAtTime() {} }, connect() {} }; }
    createMediaElementSource() { return { connect() {} }; }
    async resume() { throw new Error('Output unavailable'); }
    async close() {}
  }
  Object.assign(window, { AudioContext: FailedContext });
  let resolve!: () => void;
  t.mock.method(audio, 'play', () => new Promise<void>(ok => { resolve = () => { audio.paused = false; ok(); }; }));
  await assert.rejects(player.play(), /Output unavailable/);
  resolve(); await settle();
  assert.equal(audio.paused, true);
  assert.equal(player.getState().status, 'error');
});

test('pause before ended still emits one explicit ended state and rewinds for advancement', async t => {
  const { player, audio } = fixture(t);
  const load = player.loadStream(track());
  audio.ready(90); await load;
  await player.play();
  audio.currentTime = 90;
  audio.pause();
  assert.equal(player.getState().status, 'paused');
  assert.equal(player.getState().position, 90);
  let completions = 0;
  player.subscribe(state => { if (state.status === 'ended') completions++; });
  audio.dispatchEvent(new Event('ended'));
  assert.equal(player.getState().status, 'ended');
  assert.equal(player.getState().position, 0);
  assert.equal(player.getState().playing, false);
  assert.equal(completions, 1);
  audio.dispatchEvent(new Event('ended'));
  assert.equal(completions, 1, 'duplicate completion events do not advance twice');
  await player.play();
  assert.equal(player.getState().status, 'playing');
});
