import {
  MAX_RELEASE_NOTES_BYTES,
  parseReleaseNotesFeed,
  type ReleaseNotesFeed,
} from '@canopy/protocol/release-notes';

export interface ReleaseNotesReaderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly cacheMs?: number;
  readonly now?: () => number;
}

interface ReadState {
  readonly url: string;
  pending: Promise<ReleaseNotesFeed | null> | null;
  feed: ReleaseNotesFeed | null;
  expiresAt: number;
}

function validFeedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

async function readBoundedJson(response: Response): Promise<string> {
  if (
    Number(response.headers.get('content-length')) > MAX_RELEASE_NOTES_BYTES ||
    !response.body
  ) {
    await response.body?.cancel();
    throw new Error('Release notes response is unavailable or too large');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let json = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RELEASE_NOTES_BYTES)
        throw new Error('Release notes response is too large');
      json += decoder.decode(value, { stream: true });
    }
    return json + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Anonymous public data only. Bounded, coalesced, and never an auth dependency. */
export function createReleaseNotesReader(
  options: ReleaseNotesReaderOptions = {},
): (url: string) => Promise<ReleaseNotesFeed | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let state: ReadState | null = null;

  const load = async (url: string): Promise<ReleaseNotesFeed | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 3_000,
    );
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return parseReleaseNotesFeed(await readBoundedJson(response));
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  return async (url: string): Promise<ReleaseNotesFeed | null> => {
    if (!validFeedUrl(url)) return null;
    if (!state || state.url !== url)
      state = { url, pending: null, feed: null, expiresAt: 0 };
    const current = state;
    if (current.pending) return current.pending;
    if (now() < current.expiresAt) return current.feed;
    current.pending = load(url).then((feed) => {
      current.feed = feed;
      current.expiresAt = now() + (feed ? (options.cacheMs ?? 60_000) : 5_000);
      current.pending = null;
      return feed;
    });
    return current.pending;
  };
}
