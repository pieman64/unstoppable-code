import { Component, type ErrorInfo, type ReactNode } from 'react';
import { brandText } from '@/lib/brand';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  error: Error | null;
}

export class RootErrorBoundary extends Component<
  RootErrorBoundaryProps,
  RootErrorBoundaryState
> {
  constructor(props: RootErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    reportRendererConsoleError(
      'Top-level renderer error boundary caught an error',
      {
        name: error.name,
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      },
    );
  }

  handleReload = (): void => {
    void window.api.reloadWindow().catch(() => {
      window.location.reload();
    });
  };

  override render(): ReactNode {
    const { error } = this.state;

    if (!error) {
      return this.props.children;
    }

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-base p-6 fg-primary">
        <div className="w-full max-w-2xl rounded-xl border border-line-destructive/20 bg-card/90 p-6">
          <div className="space-y-3">
            <div>
              <h1 className="text-lg font-semibold fg-primary">
                {brandText.appName} hit a renderer error
              </h1>
              <p className="mt-1 text-s fg-secondary">
                The window was kept alive with a fallback view instead of going
                blank.
              </p>
            </div>
            <div className="rounded-lg border border-line-destructive/20 bg-destructive-subtle px-4 py-3">
              <p className="text-s fg-destructive">
                {error.message || error.name || 'Unknown renderer error'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={this.handleReload}
                className="rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition hover:opacity-90"
              >
                Reload window
              </button>
              <p className="text-xs fg-secondary">
                This usually matches `Cmd+R`, but keeps the failure visible.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
