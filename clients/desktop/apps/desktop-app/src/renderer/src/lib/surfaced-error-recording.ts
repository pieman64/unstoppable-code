import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  createSurfacedErrorRecorder,
  showsRawErrorDetail,
  type AppErrorReport,
  type AppErrorSurface,
  type SurfacedErrorRecorder,
} from '@canopy/protocol/app-errors';
import { setSurfacedErrorRecorder } from '@canopy/ui-shared/lib';

/** Fixed names only: never a boundary's label, which can name user content. */
export type RendererErrorBoundaryId = 'root' | 'chart' | 'lazy-load';

let activeRecorder: SurfacedErrorRecorder | null = null;

/**
 * Connects the shared UI's error choke points to the renderer's app-error
 * handler for this renderer runtime. The returned disposer drops the
 * registration and the recorder's dedupe cache, which can hold sensitive text.
 */
export function installSurfacedErrorRecording(): () => void {
  const recorder = createSurfacedErrorRecorder({
    report: reportClientAppError,
    recordsMessageText: showsRawErrorDetail({
      releaseFlavor: __CANOPY_RELEASE_FLAVOR__,
      isDevelopment: process.env.NODE_ENV === 'development',
    }),
  });
  activeRecorder = recorder;
  const uninstallPort = setSurfacedErrorRecorder((input) =>
    recorder.record(input),
  );
  return (): void => {
    uninstallPort();
    if (activeRecorder === recorder) activeRecorder = null;
    recorder.dispose();
  };
}

/** One report per caught failure. Never throws into a boundary's recovery. */
export function recordBoundaryError(
  identifier: RendererErrorBoundaryId,
  surface: AppErrorSurface,
  error: unknown,
): AppErrorReport | undefined {
  return activeRecorder?.record({
    chokePoint: 'boundary',
    identifier,
    surface,
    error,
  });
}
