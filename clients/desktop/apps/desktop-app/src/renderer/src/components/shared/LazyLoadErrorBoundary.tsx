import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';

interface LazyLoadErrorBoundaryProps {
  children: ReactNode;
  label: string;
  onClose?: () => void;
  onRetry: () => void;
  resetKey: string | number;
}

interface LazyLoadErrorBoundaryState {
  error: Error | null;
}

export class LazyLoadErrorBoundary extends Component<
  LazyLoadErrorBoundaryProps,
  LazyLoadErrorBoundaryState
> {
  constructor(props: LazyLoadErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): LazyLoadErrorBoundaryState {
    return { error };
  }

  override componentDidUpdate(prevProps: LazyLoadErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    reportRendererConsoleError('Lazy component failed to load', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack,
      label: this.props.label,
    });
  }

  handleRetry = (): void => {
    this.props.onRetry();
  };

  override render(): ReactNode {
    const { children, label, onClose } = this.props;
    const { error } = this.state;

    if (!error) {
      return children;
    }

    return (
      <div className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-6">
        <div
          className="w-full max-w-md rounded-lg border border-line-destructive/30 bg-card p-5"
          role="alert"
        >
          <div className="space-y-3">
            <div>
              <h2 className="text-s font-semibold fg-primary">
                {label} could not be loaded
              </h2>
              <p className="mt-1 text-xs fg-secondary">
                {error.message || error.name || 'Unknown loading error'}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2">
              {onClose ? (
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border px-3 py-1.5 text-s font-medium fg-primary transition hover:bg-secondary"
                >
                  Close
                </button>
              ) : null}
              <button
                type="button"
                onClick={this.handleRetry}
                className="rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition hover:opacity-90"
              >
                Try again
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
