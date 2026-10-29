export const CLIENT_SURFACE_HEADER = 'x-canopy-client';
export const CLIENT_SURFACE_VERSION_HEADER = 'x-canopy-client-version';

export type ClientSurface = 'web' | 'mobile' | 'desktop';

export function parseClientSurfaceHeader(
  value: string | null,
): ClientSurface | null {
  if (value === 'web' || value === 'mobile' || value === 'desktop') {
    return value;
  }
  return null;
}

const CLIENT_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;

export function parseClientVersionHeader(value: string | null): string | null {
  return value !== null && CLIENT_VERSION_PATTERN.test(value) ? value : null;
}
