import type { JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

export const GIT_LINUX_INSTALL_URL = 'https://git-scm.com/install/linux';

/** Display-only guidance reused by the machine's startup and Settings recovery. */
export function LinuxGitInstallInstructions({
  brandName,
  recheckLabel,
  onOpenInstructions,
}: {
  brandName: string;
  recheckLabel: string;
  onOpenInstructions: () => void;
}): JSX.Element {
  return (
    <>
      <p
        className="text-s fg-secondary"
        data-testid="git-gate-install-explanation"
      >
        To use {brandName} on Ubuntu, run{' '}
        <code className={POSTHOG_REPLAY_BLOCK_CLASS}>
          sudo apt update &amp;&amp; sudo apt install git
        </code>{' '}
        in a terminal, then select {recheckLabel}. On other Linux distributions,
        use your package manager.
      </p>
      <Button
        variant="secondary"
        onClick={onOpenInstructions}
        data-testid="git-gate-manual"
      >
        Installation instructions
      </Button>
    </>
  );
}
