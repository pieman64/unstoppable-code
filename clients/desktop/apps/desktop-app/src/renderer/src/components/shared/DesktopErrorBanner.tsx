import type { ComponentProps, JSX } from 'react';
import { ErrorBanner } from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import { rendererAppErrorDisplayPolicy } from '@/lib/renderer-app-error';
import { DesktopReportThisAction } from './DesktopReportThisAction';

type Props = Omit<
  ComponentProps<typeof ErrorBanner>,
  'displayPolicy' | 'reportAction'
>;

/**
 * The shared `ErrorBanner` with the renderer's raw-detail policy and the
 * desktop `Report this` gate. The banner renders the report action only
 * beside a defect, with the error whose reference it shows; the gate's own
 * boundary keeps a report failure from hiding the original error.
 */
export function DesktopErrorBanner(props: Props): JSX.Element | null {
  return (
    <ErrorBanner
      {...props}
      displayPolicy={rendererAppErrorDisplayPolicy}
      reportAction={(defect): JSX.Element => (
        <DesktopReportThisAction error={defect} appName={brandText.appName} />
      )}
    />
  );
}
