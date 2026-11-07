import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CanopyClientProvider } from '@canopy/app-state';
import type { AppError } from '@canopy/protocol/app-errors';
import type { FeedbackReportTelemetry } from '@canopy/protocol/feedback-report';
import { ReportActionBoundary } from '@canopy/ui-app';
import {
  AppErrorDetails,
  ErrorBanner,
  Heading,
  Surface,
} from '@canopy/ui-shared/components';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { brandText } from '@/lib/brand';
import {
  captureRendererAppError,
  presentRendererAppError,
} from '@/lib/renderer-app-error';
import { captureClientInstrumentationError } from '@canopy/desktop-instrumentation/client';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { Button } from '@/components/shared/Button';
import { DesktopReportThisAction } from './DesktopReportThisAction';

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  error: Error | null;
  appError: AppError | null;
  telemetry: FeedbackReportTelemetry | null;
}

export class RootErrorBoundary extends Component<
  RootErrorBoundaryProps,
  RootErrorBoundaryState
> {
  constructor(props: RootErrorBoundaryProps) {
    super(props);
    this.state = { error: null, appError: null, telemetry: null };
  }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error, appError: null, telemetry: null };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    captureClientInstrumentationError(error, {
      context: { boundary: 'root' },
    });
    reportRendererConsoleError(
      'Top-level renderer error boundary caught an error',
      {
        name: error.name,
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      },
    );
    this.setState(captureRendererAppError(error, 'window', 'root'));
  }

  handleReload = (): void => {
    void window.api.reloadWindow().catch(() => {
      window.location.reload();
    });
  };

  override render(): ReactNode {
    const { error, appError, telemetry } = this.state;

    if (!error) {
      return this.props.children;
    }

    const presentation = appError ? presentRendererAppError(appError) : null;

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-base p-6 fg-primary">
        <Surface variant="group" padding="roomy" className="w-full max-w-2xl">
          <div className="space-y-3">
            <div>
              <Heading level={1} variant="page">
                {brandText.appName} hit a renderer error
              </Heading>
              <p className="mt-1 text-s fg-secondary">
                The window was kept alive with a fallback view instead of going
                blank.
              </p>
            </div>
            {/* Catalog copy only: raw text stays behind Technical details, so
                a stable build never shows it, even on the first paint. */}
            {presentation ? (
              <div data-selectable>
                <ErrorBanner
                  className=""
                  error={presentation.copy.title}
                  errorRecordingDisabled
                />
              </div>
            ) : null}
            {presentation ? (
              <ReportActionBoundary>
                <AppErrorDetails presentation={presentation} />
              </ReportActionBoundary>
            ) : null}
            <div className="flex items-center gap-3">
              <Button variant="primary" onClick={this.handleReload}>
                Reload window
              </Button>
              {appError ? (
                <ReportActionBoundary>
                  {/* The fallback sits outside the app's provider. */}
                  <CanopyClientProvider client={ipcCanopyClient}>
                    <DesktopReportThisAction
                      error={appError}
                      appName={brandText.appName}
                      {...(telemetry ? { telemetry } : {})}
                    />
                  </CanopyClientProvider>
                </ReportActionBoundary>
              ) : null}
              <p className="text-xs fg-secondary">
                This usually matches `Cmd+R`, but keeps the failure visible.
              </p>
            </div>
          </div>
        </Surface>
      </div>
    );
  }
}
