import type {
  AppErrorReport,
  SurfacedErrorInput,
} from '@canopy/protocol/app-errors';

/**
 * The host's recorder for errors shown through shared UI. Shared components
 * call the port; the host decides whether anything is reported, so this
 * package stays free of instrumentation and host imports. The sink returns
 * the host's report so a banner can show the reference the host recorded.
 */
export type SurfacedErrorSink = (
  input: SurfacedErrorInput,
) => AppErrorReport | undefined;

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

/**
 * The host's report, so shared UI can show the reference the host recorded;
 * `undefined` without a recorder or when it fails. A failing recorder never
 * reaches the UI.
 */
export function recordSurfacedError(
  input: SurfacedErrorInput,
): AppErrorReport | undefined {
  try {
    return registration?.sink(input);
  } catch {
    // Recording is best effort and must not report its own failure.
    return undefined;
  }
}
