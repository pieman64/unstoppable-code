import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useState, type JSX } from 'react';
import {
  Button,
  LoadingSpinner,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import type { RemoteIncomingPairing } from '@canopy/desktop-shared/types';
import { DialogModal } from '@/components/shared/DialogModal';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import {
  CONTROL_RISK_SENTENCE,
  describeError,
  formatPairingCode,
} from './remote-access-copy';

export interface IncomingPairingPromptProps {
  readonly request: RemoteIncomingPairing;
}

/**
 * Asks the person at this computer whether another computer on the account
 * may control it. Shown in this computer's own windows only, one request at a
 * time; main expires a request nobody answers. Dismissing declines.
 */
export function IncomingPairingPrompt({
  request,
}: IncomingPairingPromptProps): JSX.Element {
  const respondToPairing = useRemoteControlStore((s) => s.respondToPairing);
  const [busy, setBusy] = useState<'allow' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = (approve: boolean): void => {
    if (busy) return;
    setBusy(approve ? 'allow' : 'decline');
    setError(null);
    void respondToPairing({ pairingId: request.pairingId, approve })
      .catch((cause: unknown) => {
        setError(describeError(cause, "Couldn't send your answer. Try again."));
      })
      .finally(() => setBusy(null));
  };

  return (
    <DialogModal
      onClose={() => respond(false)}
      closeOnBackdrop={false}
      closeOnEscape={busy === null}
      closeButtonDisabled={busy !== null}
      title={`Allow ${request.name} to control this computer?`}
      maxWidth="md"
      trapFocus
      dataTestId="remote-access-incoming-pairing"
    >
      <div className="flex flex-col gap-4">
        <p className="text-s fg-secondary">
          {request.name} {CONTROL_RISK_SENTENCE}. Allow it only if this code
          matches the one on {request.name}.
        </p>
        <p
          aria-label={`Pairing code ${request.code.split('').join(' ')}`}
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} text-center font-mono text-3xl font-medium tabular-nums fg-primary`}
          data-testid="remote-access-incoming-pairing-code"
        >
          {formatPairingCode(request.code)}
        </p>
        <ErrorBanner error={error} className="" />
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="lg"
            disabled={busy !== null}
            onClick={() => respond(false)}
            data-testid="remote-access-incoming-pairing-decline"
          >
            {busy === 'decline' ? (
              <LoadingSpinner className="shrink-0" decorative />
            ) : null}
            Decline
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={busy !== null}
            aria-busy={busy === 'allow'}
            onClick={() => respond(true)}
            data-testid="remote-access-incoming-pairing-allow"
          >
            {busy === 'allow' ? (
              <LoadingSpinner className="shrink-0" decorative />
            ) : null}
            Allow
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
