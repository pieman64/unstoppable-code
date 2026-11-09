import type { JSX } from 'react';
import type { RemoteIncomingPairing } from '@canopy/desktop-shared/types';
import { DialogModal } from '@/components/shared/DialogModal';
import {
  IncomingPairingRequestActions,
  IncomingPairingRequestBody,
} from './IncomingPairingRequest';
import {
  incomingPairingTitle,
  useIncomingPairingResponse,
} from './incoming-pairing-response';

export interface IncomingPairingPromptProps {
  readonly request: RemoteIncomingPairing;
}

/**
 * Asks the person at this computer whether a device on the account may
 * control it after comparing codes (CAN-5985 A3, or A6 for hosted agents).
 * Shown in this computer's own windows only, one request at a time, while
 * the Remote Control dialog (which shows the same request itself) is
 * closed; main expires a request nobody answers. Dismissing denies.
 */
export function IncomingPairingPrompt({
  request,
}: IncomingPairingPromptProps): JSX.Element {
  const { busy, error, respond } = useIncomingPairingResponse(
    request.pairingId,
  );
  return (
    <DialogModal
      onClose={() => respond(false)}
      closeOnBackdrop={false}
      closeOnEscape={busy === null}
      closeButtonDisabled={busy !== null}
      title={incomingPairingTitle(request)}
      maxWidth="md"
      trapFocus
      dataTestId="remote-access-incoming-pairing"
      footer={<IncomingPairingRequestActions busy={busy} onRespond={respond} />}
    >
      <IncomingPairingRequestBody request={request} error={error} />
    </DialogModal>
  );
}
