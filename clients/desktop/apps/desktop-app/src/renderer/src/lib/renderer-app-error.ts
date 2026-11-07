import {
  readClientErrorTelemetry,
  reportClientAppError,
} from '@canopy/desktop-instrumentation/client';
import {
  presentAppError,
  toAppError,
  type AppError,
  type AppErrorPresentation,
  type AppErrorSurface,
} from '@canopy/protocol/app-errors';
import type { FeedbackReportTelemetry } from '@canopy/protocol/feedback-report';
import {
  recordBoundaryError,
  type RendererErrorBoundaryId,
} from './surfaced-error-recording';

export interface CapturedRendererAppError {
  appError: AppError | null;
  telemetry: FeedbackReportTelemetry | null;
}

function normalize(
  error: unknown,
  surface: AppErrorSurface,
  boundary?: RendererErrorBoundaryId,
): AppError | null {
  const reported = boundary
    ? recordBoundaryError(boundary, surface, error)
    : reportClientAppError(error, { surface });
  if (reported) return reported.error;
  try {
    return toAppError(error) ?? null;
  } catch (failure) {
    reportClientAppError(failure, { surface });
    return null;
  }
}

/**
 * Called once per occurrence, from `componentDidCatch`, so the reference and
 * session links belong to this crash. With no app error the boundary keeps its
 * generic recovery view, without Details or Report this.
 */
export function captureRendererAppError(
  error: unknown,
  surface: AppErrorSurface,
  boundary?: RendererErrorBoundaryId,
): CapturedRendererAppError {
  const appError = normalize(error, surface, boundary);
  if (!appError) return { appError: null, telemetry: null };
  try {
    return { appError, telemetry: readClientErrorTelemetry() };
  } catch (failure) {
    reportClientAppError(failure, { surface });
    return { appError, telemetry: null };
  }
}

export function presentRendererAppError(error: AppError): AppErrorPresentation {
  return presentAppError(error, {
    releaseFlavor: __CANOPY_RELEASE_FLAVOR__,
    isDevelopment: process.env.NODE_ENV === 'development',
  });
}
