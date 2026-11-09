import type { JSX, ReactNode } from 'react';
import { AppErrorBoundary } from '@canopy/ui-app';
import { chartErrorBoundaryHost } from '@/lib/desktop-error-boundary-host';
import { RenderFaultProbe } from '@/lib/e2e-render-fault';

interface ChartErrorBoundaryProps {
  children: ReactNode;
  /** Diagnostic only: it reaches the console log, never the fallback. */
  label: string;
  minHeight?: number;
}

export function ChartErrorBoundary({
  children,
  label,
  minHeight = 280,
}: ChartErrorBoundaryProps): JSX.Element {
  return (
    <AppErrorBoundary
      layout="inline"
      message="Couldn't show this chart."
      minHeight={minHeight}
      testId="chart-error-fallback"
      host={chartErrorBoundaryHost}
      context={{ label }}
    >
      {__CANOPY_E2E__ ? <RenderFaultProbe target="chart" /> : null}
      <div>{children}</div>
    </AppErrorBoundary>
  );
}
