import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { ErrorState } from '@canopy/ui-shared/components';

interface ChartErrorBoundaryProps {
  children: ReactNode;
  label: string;
  minHeight?: number;
}

interface ChartErrorBoundaryState {
  error: Error | null;
  retryKey: number;
}

export class ChartErrorBoundary extends Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props);
    this.state = { error: null, retryKey: 0 };
  }

  static getDerivedStateFromError(
    error: Error,
  ): Partial<ChartErrorBoundaryState> {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    reportRendererConsoleError('Chart error boundary caught an error', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      label: this.props.label,
    });
  }

  handleRetry = (): void => {
    this.setState((state) => ({
      error: null,
      retryKey: state.retryKey + 1,
    }));
  };

  override render(): ReactNode {
    const { children, label, minHeight = 280 } = this.props;
    const { error, retryKey } = this.state;

    if (error) {
      return (
        // The crash details are logged in componentDidCatch.
        <div className="flex flex-col justify-center" style={{ minHeight }}>
          <ErrorState
            space="panel"
            message={`${label} could not be rendered.`}
            onRetry={this.handleRetry}
          />
        </div>
      );
    }

    return <div key={retryKey}>{children}</div>;
  }
}
