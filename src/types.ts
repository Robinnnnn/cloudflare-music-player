export interface CatalogTrack {
  id: string;
  title: string;
  artist: string;
  objectKey: string;
  externalUrl?: string;
}

export interface CatalogPlaylist {
  id: string;
  title: string;
  trackIds: string[];
}

export interface Catalog {
  version: 1;
  tracks: CatalogTrack[];
  playlists: CatalogPlaylist[];
}

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
