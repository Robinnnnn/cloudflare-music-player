/** One speculative recording; only its completed Blob can become active media. */
export function createStreamPreloader(fetchAudio: typeof globalThis.fetch) {
  let pending: { url: string; controller: AbortController; blob?: Blob } | undefined;
  const clear = () => { pending?.controller.abort(); pending = undefined; };
  return {
    clear,
    preload(url: string) {
      let parsed: URL;
      try { parsed = new URL(url); } catch { clear(); return; }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) { clear(); return; }
      url = parsed.href;
      if (pending?.url === url) return;
      clear();
      const request = { url, controller: new AbortController(), blob: undefined as Blob | undefined };
      pending = request;
      void Promise.resolve().then(() => {
        if (pending !== request) return undefined;
        return fetchAudio(url, { signal: request.controller.signal });
      }).then(async response => {
        if (!response) return;
        if (!response.ok) throw new Error('Preload unavailable');
        const blob = await response.blob();
        if (pending === request && !request.controller.signal.aborted && blob.size) request.blob = blob;
      }).catch(() => { if (pending === request) clear(); });
    },
    /** Consuming never waits: an unfinished/failed download uses normal streaming. */
    take(url: string): Blob | undefined {
      const blob = pending?.url === url ? pending.blob : undefined;
      clear();
      return blob;
    },
  };
}
