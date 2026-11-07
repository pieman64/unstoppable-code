import { MAX_STREAMS } from '../../runtime/local-worker-binding-wire';

export const DEFAULT_MAX_ACTIVE_REQUESTS = 128;
export const DEFAULT_LEASE_STREAM_LIMIT = 32;
export const APP_STREAM_REQUEST_HEADROOM = 16;
// No desktop root-count cap exists; bound = connection capacity minus request headroom.
export const APP_LEASE_STREAM_LIMIT = Math.min(
  DEFAULT_MAX_ACTIVE_REQUESTS - APP_STREAM_REQUEST_HEADROOM,
  MAX_STREAMS,
);
