import type { JSX, ReactNode } from 'react';
import { AppErrorBoundary } from '@canopy/ui-app';
import { DialogModal } from '@canopy/ui-shared/components';
import { Button } from '@/components/shared/Button';
import { lazyLoadErrorBoundaryHost } from '@/lib/desktop-error-boundary-host';
import { RenderFaultProbe } from '@/lib/e2e-render-fault';

interface LazyLoadErrorBoundaryProps {
  children: ReactNode;
  /** What failed to load: the dialog's title. */
  label: string;
  /** One sentence for the dialog's body: `Couldn't load project settings.` */
  message: string;
  onClose?: () => void;
  onRetry: () => void;
  resetKey: string | number;
}

function noop(): void {}

export function LazyLoadErrorBoundary({
  children,
  label,
  message,
  onClose,
  onRetry,
  resetKey,
}: LazyLoadErrorBoundaryProps): JSX.Element {
  return (
    <AppErrorBoundary
      layout="inline"
      message={<span id="lazy-load-error-message">{message}</span>}
      testId="lazy-load-error-fallback"
      host={lazyLoadErrorBoundaryHost}
      context={{ label }}
      resetKey={resetKey}
      onRecover={onRetry}
      // A load failure opens without the user asking, so focus lands on the
      // card rather than on a button the next keypress would press. With no
      // Close there is no way out but Try again: Escape and the scrim do
      // nothing.
      renderFrame={(fallback) => (
        <DialogModal
          variant="confirm"
          title={label}
          titleId="lazy-load-error-title"
          onClose={onClose ?? noop}
          closeOnBackdrop={false}
          closeOnEscape={onClose !== undefined}
          trapFocus
          initialFocus="dialog"
          dataTestId="lazy-load-error"
          ariaDescribedBy="lazy-load-error-message"
          footer={
            onClose ? (
              <Button variant="secondary" size="compact" onClick={onClose}>
                Close
              </Button>
            ) : undefined
          }
        >
          {fallback}
        </DialogModal>
      )}
    >
      {__CANOPY_E2E__ ? <RenderFaultProbe target="lazy-load" /> : null}
      {children}
    </AppErrorBoundary>
  );
}
