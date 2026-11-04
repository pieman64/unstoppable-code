import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ErrorBanner, Heading } from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { Button } from '@/components/shared/Button';

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
              <Heading level={1} variant="page">
                {brandText.appName} hit a renderer error
              </Heading>
              <p className="mt-1 text-s fg-secondary">
                The window was kept alive with a fallback view instead of going
                blank.
              </p>
            </div>
            <div data-selectable>
              <ErrorBanner
                className=""
                error={error.message || error.name || 'Unknown renderer error'}
              />
            </div>
            <div className="flex items-center gap-3">
              <Button variant="primary" onClick={this.handleReload}>
                Reload window
              </Button>
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
