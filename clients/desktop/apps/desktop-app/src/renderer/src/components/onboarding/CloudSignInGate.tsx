import type { JSX } from 'react';
import { usesNativeWindowFrame } from '@canopy/desktop-shared/platform-capabilities';
import { localPlatform } from '@/lib/local-platform';
import { BrandLogo } from '@/components/BrandLogo';
import { CloudAuthPanel } from '@/components/auth/CloudAuthPanel';
import type { CanopyCloudConnectSuccess } from '@/components/auth/useCanopyCloudAuth';
import {
  didGuestMergeFail,
  showGuestMergeFailureToast,
} from '@/components/auth/guestMergeFailure';
import { brandText } from '@/lib/brand';
import { Heading } from '@canopy/ui-shared/components';

export interface CloudSignInGateProps {
  /**
   * Invoked when the embedded account panel reports a fully connected Canopy
   * Cloud account. The host (`App.tsx`) uses this to dismiss the gate and reveal
   * the main shell without a restart.
   */
  onConnected: () => void;
}

/**
 * Full-window, fully blocking sign-in splash shown by App.tsx when the
 * `canopy-cloud-sign-in-required` flag is enabled and no Canopy Cloud account is
 * connected. There is no "skip" affordance: the only way past is to connect an
 * account (or quit the app).
 *
 * The panel itself is the shared `CloudAuthPanel` in its `splash` layout — the
 * same component the cloud-connect modal renders — so the OAuth + API-key flow
 * has exactly one implementation across both surfaces.
 */
export function CloudSignInGate({
  onConnected,
}: CloudSignInGateProps): JSX.Element {
  const handleConnectSuccess = (result: CanopyCloudConnectSuccess): void => {
    if (didGuestMergeFail(result)) showGuestMergeFailureToast();
    onConnected();
  };

  return (
    // The window's whole content in place of the shell, not a layer over it.
    <div
      className="flex h-screen w-full flex-col items-center justify-center overflow-hidden bg-base fg-primary animate-fade-in"
      data-testid="cloud-sign-in-gate"
    >
      {/* Keep the window draggable behind the centered content. */}
      {!usesNativeWindowFrame(localPlatform()) && (
        <div className="electron-drag h-10 shrink-0 w-full" />
      )}
      <div className="flex flex-1 w-full items-center justify-center overflow-y-auto px-6 pb-10">
        <div className="w-full max-w-sm flex flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-4 text-center">
            <BrandLogo size={72} className="select-none fg-accent" />
            <div className="flex flex-col items-center gap-2">
              <Heading level={1} variant="page">
                Welcome to {brandText.appName}
              </Heading>
              <p className="text-s fg-secondary">
                Connect your account to start building.
              </p>
            </div>
          </div>
          <div className="w-full rounded-2xl border bg-card/60 p-6">
            <CloudAuthPanel
              layout="splash"
              // The panel's default lead is written for a guest upgrading in
              // place ("nothing you've built gets left behind"). This gate
              // blocks a FRESH install, where the user has built nothing and
              // that reassurance lands directly under "start building" as a
              // contradiction. Keep only the half that is true here.
              lead="Free account, no card required."
              onConnectSuccess={handleConnectSuccess}
              onReadyToContinue={onConnected}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
