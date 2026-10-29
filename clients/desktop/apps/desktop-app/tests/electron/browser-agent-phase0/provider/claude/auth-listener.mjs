// Bounded per-request auth classification for the OAuth+loopback arm. Only
// booleans, the method and a credential-free path are retained: never a header
// value, token substring or length (shared/followup-policy.mjs classifies).
import { createCaptureServer } from '../../../mock-server/capture-server.mjs';
import { classifySyntheticAuth } from '../shared/followup-policy.mjs';

const MAX_OBSERVATIONS = 200;
const MAX_PATH = 120;

/** A pure observer: `observe(request)` records booleans for one request. */
export function createAuthObserver({ max = MAX_OBSERVATIONS } = {}) {
  const observations = [];
  let total = 0;
  let dropped = 0;
  return {
    observe(request) {
      total += 1;
      if (observations.length >= max) {
        dropped += 1;
        return;
      }
      const url = String(request?.url ?? '');
      const pathname = url.split('?')[0].slice(0, MAX_PATH);
      observations.push({
        method: String(request?.method ?? '').slice(0, 10),
        path: pathname,
        ...classifySyntheticAuth(request?.headers ?? {}),
      });
    },
    reset() {
      observations.length = 0;
      total = 0;
      dropped = 0;
    },
    snapshot() {
      return {
        total,
        retained: observations.length,
        dropped,
        observations: observations.map((entry) => ({ ...entry })),
      };
    },
    summarize() {
      const bearer = observations.filter((entry) => entry.bearer).length;
      const syntheticOAuth = observations.filter(
        (entry) => entry.syntheticOAuth,
      ).length;
      const apiKey = observations.filter((entry) => entry.apiKey).length;
      const syntheticApiKey = observations.filter(
        (entry) => entry.syntheticApiKey,
      ).length;
      return {
        total,
        retained: observations.length,
        dropped,
        bearer,
        syntheticOAuth,
        apiKey,
        syntheticApiKey,
        // A request with a bearer that is not the placeholder would mean an unexpected credential source.
        unexpectedBearer: bearer - syntheticOAuth,
      };
    },
  };
}

/**
 * The capture listener (existing seam) with a prepended request listener that
 * feeds the observer. The listener never reads a body and never calls
 * `response`, so the capture server's behavior is unchanged.
 */
export async function startAuthObservedCapture(limits = {}) {
  const { server, capture, close } = createCaptureServer(limits);
  const observer = createAuthObserver();
  server.prependListener('request', (request) => observer.observe(request));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Capture listener has no port');
  return {
    capture,
    close,
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    auth: observer,
  };
}
