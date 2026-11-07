import { Component, type ErrorInfo, type ReactNode } from 'react';
import type { FeedbackReportTelemetry } from '@canopy/protocol/feedback-report';
import type { AppError } from '@canopy/protocol/app-errors';
import { ReportActionBoundary } from '@canopy/ui-app';
import { AppErrorDetails, ErrorState } from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import {
  captureRendererAppError,
  presentRendererAppError,
} from '@/lib/renderer-app-error';
import { captureClientInstrumentationError } from '@canopy/desktop-instrumentation/client';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { DesktopReportThisAction } from './DesktopReportThisAction';

interface ChartErrorBoundaryProps {
  children: ReactNode;
  label: string;
  minHeight?: number;
}

interface ChartErrorBoundaryState {
  error: Error | null;
  appError: AppError | null;
  telemetry: FeedbackReportTelemetry | null;
  retryKey: number;
}

export class ChartErrorBoundary extends Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props);
    this.state = { error: null, appError: null, telemetry: null, retryKey: 0 };
  }

  static getDerivedStateFromError(
    error: Error,
  ): Partial<ChartErrorBoundaryState> {
    return { error, appError: null, telemetry: null };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    captureClientInstrumentationError(error, {
      context: { boundary: 'chart' },
    });
    reportRendererConsoleError('Chart error boundary caught an error', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      label: this.props.label,
    });
    this.setState(captureRendererAppError(error, 'panel', 'chart'));
  }

  handleRetry = (): void => {
    this.setState((state) => ({
      error: null,
      appError: null,
      telemetry: null,
      retryKey: state.retryKey + 1,
    }));
  };

  override render(): ReactNode {
    const { children, label, minHeight = 280 } = this.props;
    const { error, appError, telemetry, retryKey } = this.state;

    if (error) {
      const presentation = appError ? presentRendererAppError(appError) : null;
      return (
        // The crash details are logged in componentDidCatch.
        <div className="flex flex-col justify-center" style={{ minHeight }}>
          <ErrorState
            space="panel"
            message={
              presentation?.copy.title ?? `${label} could not be rendered.`
            }
            onRetry={this.handleRetry}
            secondaryAction={
              appError ? (
                <DesktopReportThisAction
                  error={appError}
                  appName={brandText.appName}
                  {...(telemetry ? { telemetry } : {})}
                />
              ) : undefined
            }
          />
          {presentation ? (
            <ReportActionBoundary>
              <AppErrorDetails
                className="items-center"
                presentation={presentation}
              />
            </ReportActionBoundary>
          ) : null}
        </div>
      );
    }

    return <div key={retryKey}>{children}</div>;
  }
}
