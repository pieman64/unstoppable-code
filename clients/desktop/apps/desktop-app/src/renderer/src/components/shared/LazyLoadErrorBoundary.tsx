import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportRendererConsoleError } from '@/lib/renderer-error-logging';
import { Button } from '@/components/shared/Button';
import { DialogModal } from '@canopy/ui-shared/components';

interface LazyLoadErrorBoundaryProps {
  children: ReactNode;
  label: string;
  onClose?: () => void;
  onRetry: () => void;
  resetKey: string | number;
}

function noop(): void {}

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

    // A load failure opens without the user asking, so focus lands on the
    // card rather than on a button the next keypress would press. With no
    // Close there is no way out but Try again: Escape and the scrim do nothing.
    return (
      <DialogModal
        variant="confirm"
        title={`${label} could not be loaded`}
        titleId="lazy-load-error-title"
        onClose={onClose ?? noop}
        closeOnBackdrop={false}
        closeOnEscape={onClose !== undefined}
        trapFocus
        initialFocus="dialog"
        dataTestId="lazy-load-error"
        ariaDescribedBy="lazy-load-error-message"
        footer={
          <>
            {onClose ? (
              <Button variant="secondary" size="compact" onClick={onClose}>
                Close
              </Button>
            ) : null}
            <Button variant="primary" size="compact" onClick={this.handleRetry}>
              Try again
            </Button>
          </>
        }
      >
        <p id="lazy-load-error-message" className="text-s fg-secondary">
          {error.message || error.name || 'Unknown loading error'}
        </p>
      </DialogModal>
    );
  }
}
