export interface Track {
  id: string;
  title: string;
  artist: string;
  audioUrl: string;
  externalUrl?: string;
}
export interface Playlist {
  id: string;
  title: string;
  tracks: Track[];
}
