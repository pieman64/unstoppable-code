import type { SurfacedErrorInput } from '@canopy/protocol/app-errors';

/**
 * The host's recorder for errors shown through shared UI. Shared components
 * call the port; the host decides whether anything is reported, so this
 * package stays free of instrumentation and host imports.
 */
export type SurfacedErrorSink = (input: SurfacedErrorInput) => unknown;

let registration: { readonly sink: SurfacedErrorSink } | null = null;

/**
 * Installs the host's recorder. The returned uninstaller only removes its own
 * registration, so a stale one cannot remove a newer install, even of the same
 * callback.
 */
export function setSurfacedErrorRecorder(sink: SurfacedErrorSink): () => void {
  const own = { sink };
  registration = own;
  return (): void => {
    if (registration === own) registration = null;
  };
}

/** No-op without a host recorder. A failing recorder never reaches the UI. */
export function recordSurfacedError(input: SurfacedErrorInput): void {
  try {
    registration?.sink(input);
  } catch {
    // Recording is best effort and must not report its own failure.
  }
}
