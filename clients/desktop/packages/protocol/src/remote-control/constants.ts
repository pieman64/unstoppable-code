/** Controller windows supported by the desktop bridge. */
export const REMOTE_SURFACES = ['main', 'app-advisor'] as const;
export type RemoteSurface = (typeof REMOTE_SURFACES)[number];
export const ACCOUNT_PROXY_SIGN_IN_STATE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Wire limits shared by Node and portable codecs. */
export const MAX_FRAGMENT_BYTES = 65_470;
export const MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
export const COMPRESSION_THRESHOLD_BYTES = 8 * 1024;
