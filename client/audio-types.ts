export interface TrackInfo {
  title: string;
  artist: string;
  duration: number;
  source: 'demo' | 'file' | 'stream';
}

export interface StreamTrack {
  url: string;
  title: string;
  artist: string;
  duration?: number;
}

export interface PlaybackState {
  status?: 'loading' | 'ready' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error';
  error?: string | null;
  playing: boolean;
  /** Current eased output gain, when supplied by the browser audio engine. */
  outputLevel?: number;
  position: number;
  volume: number;
  track: TrackInfo;
}

export interface AudioPlayer {
  prepare(): Promise<void>;
  play(): Promise<void>;
  pause(immediate?: boolean): void;
  seek(seconds: number): void;
  setVolume(volume: number): void;
  loadFile(file: File): Promise<void>;
  loadStream(track: StreamTrack): Promise<void>;
  /** Cache at most one next recording, without playing it. */
  preloadStream(track: StreamTrack): void;
  getState(): PlaybackState;
  subscribe(listener: (state: PlaybackState) => void): () => void;
  dispose(): void;
}
