import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { Button } from '@/components/shared/Button';

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
        <div
          className="flex flex-col items-center justify-center gap-3 rounded border border-line-destructive/30 bg-destructive/5 px-4 text-center"
          role="alert"
          style={{ minHeight }}
        >
          <div>
            <div className="text-s font-medium fg-destructive">
              {label} could not be rendered.
            </div>
            <div className="mt-1 max-w-xl text-xs fg-secondary">
              {error.message || error.name || 'Unknown chart error'}
            </div>
          </div>
          <Button variant="primary" onClick={this.handleRetry}>
            Reload chart
          </Button>
        </div>
      );
    }

    return <div key={retryKey}>{children}</div>;
  }
}
