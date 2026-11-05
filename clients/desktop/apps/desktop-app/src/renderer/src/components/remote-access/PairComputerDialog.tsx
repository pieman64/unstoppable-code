import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  Button,
  EmptyState,
  ListRow,
  LoadingSpinner,
  Notice,
  NoticeButton,
  ErrorBanner,
} from '@canopy/ui-shared/components';
import { MacbookIcon } from '@canopy/ui-shared/icons/AppIcons';
import type {
  RemoteControlDevice,
  RemoteOutgoingPairing,
} from '@canopy/desktop-shared/types';
import { DialogModal } from '@/components/shared/DialogModal';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import {
  describeError,
  formatPairingCode,
  platformLabel,
} from './remote-access-copy';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';

/** Main keeps discovery alive for about five minutes per request. */
const DISCOVERY_REFRESH_MS = 4 * 60_000;

export interface PairComputerDialogProps {
  readonly onClose: () => void;
}

type Phase = 'choose' | 'pairing';

/**
 * Pairs this computer with another one on the same account so this one can
 * control it. Lists the computers that accept pairing, starts the handshake
 * with the one the user picks, and shows the six-digit code both computers
 * display until the other computer approves or declines.
 */
export function PairComputerDialog({
  onClose,
}: PairComputerDialogProps): JSX.Element {
  const { state, discover, startPairing, cancelPairing, openMachine } =
    useRemoteControlStore(
      useShallow((store) => ({
        state: store.state,
        discover: store.discover,
        startPairing: store.startPairing,
        cancelPairing: store.cancelPairing,
        openMachine: store.openMachine,
      })),
    );
  const pairing = state.outgoingPairing;
  const [phase, setPhase] = useState<Phase>(() =>
    pairing === null ? 'choose' : 'pairing',
  );
  const [discovered, setDiscovered] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastDeviceRef = useRef<RemoteControlDevice | null>(pairing);
  // A start still in flight when the dialog closes is cancelled once it lands.
  const startingRef = useRef(false);
  const closedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const run = (): void => {
      void discover()
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setDiscovered(true);
        });
    };
    run();
    const timer = window.setInterval(run, DISCOVERY_REFRESH_MS);
    return (): void => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [discover]);

  const close = (): void => {
    closedRef.current = true;
    // Leaving mid-handshake abandons it; after an outcome this only clears
    // the finished attempt (an approved pairing stays paired).
    if (!startingRef.current && state.outgoingPairing !== null) {
      void cancelPairing().catch(() => undefined);
    }
    onClose();
  };

  const pair = (device: RemoteControlDevice): void => {
    lastDeviceRef.current = device;
    setActionError(null);
    setBusy(true);
    startingRef.current = true;
    void startPairing(device.deviceId)
      .then(() => {
        if (closedRef.current) {
          void cancelPairing().catch(() => undefined);
          return;
        }
        setPhase('pairing');
      })
      .catch((cause: unknown) => {
        if (closedRef.current) return;
        setPhase('choose');
        setActionError(
          describeError(cause, `Couldn't reach ${device.name}. Try again.`),
        );
      })
      .finally(() => {
        startingRef.current = false;
        if (!closedRef.current) setBusy(false);
      });
  };

  const backToList = (): void => {
    setActionError(null);
    setPhase('choose');
    void cancelPairing().catch(() => undefined);
  };

  const openPaired = (deviceId: string): void => {
    setActionError(null);
    setBusy(true);
    void openMachine(deviceId)
      .then(() => {
        void cancelPairing().catch(() => undefined);
        onClose();
      })
      .catch((cause: unknown) => {
        // Stay open so the user sees why and can try again.
        setBusy(false);
        setActionError(describeError(cause, "Couldn't open that computer."));
      });
  };

  const openAccounts = (): void => {
    onClose();
    openCloudAccountSettings();
  };

  let body: ReactNode;
  let footer: ReactNode;
  if (phase === 'pairing' && pairing !== null) {
    ({ body, footer } = renderPairing({
      pairing,
      busy,
      onCancel: close,
      onRetry: (): void => {
        const device = lastDeviceRef.current ?? pairing;
        pair(device);
      },
      onBack: backToList,
      onOpen: () => openPaired(pairing.deviceId),
    }));
  } else if (phase === 'pairing') {
    // Started, but the snapshot with the attempt has not arrived yet.
    body = (
      <StatusLine>
        <LoadingSpinner tone="secondary" decorative />
        Connecting…
      </StatusLine>
    );
    footer = (
      <Button variant="outline" size="lg" onClick={close}>
        Cancel
      </Button>
    );
  } else {
    body = renderChoose({
      signedIn: state.signedIn,
      relayUnavailable: state.relayStatus === 'unavailable',
      discovered,
      devices: state.discoverable,
      busy,
      onPair: pair,
      onOpenAccounts: openAccounts,
    });
    footer = (
      <Button
        variant="outline"
        size="lg"
        onClick={close}
        data-testid="remote-access-pair-cancel"
      >
        Cancel
      </Button>
    );
  }

  return (
    <DialogModal
      onClose={close}
      title="Add a computer"
      maxWidth="md"
      trapFocus
      dataTestId="remote-access-pair-dialog"
    >
      <div className="flex flex-col gap-4">
        {body}
        <ErrorBanner
          className=""
          error={actionError}
          testId="remote-access-pair-error"
        />
        <div className="flex items-center justify-end gap-2">{footer}</div>
      </div>
    </DialogModal>
  );
}

function StatusLine({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p
      role="status"
      className="flex items-center gap-2 text-s fg-secondary"
      data-testid="remote-access-pair-status"
    >
      {children}
    </p>
  );
}

interface ChooseProps {
  readonly signedIn: boolean;
  readonly relayUnavailable: boolean;
  readonly discovered: boolean;
  readonly devices: readonly RemoteControlDevice[];
  readonly busy: boolean;
  readonly onPair: (device: RemoteControlDevice) => void;
  readonly onOpenAccounts: () => void;
}

function renderChoose({
  signedIn,
  relayUnavailable,
  discovered,
  devices,
  busy,
  onPair,
  onOpenAccounts,
}: ChooseProps): ReactNode {
  if (!signedIn) {
    return (
      <Notice
        intent="attention"
        title="Sign in to pair computers"
        data-testid="remote-access-pair-signed-out"
        actions={
          <NoticeButton variant="primary" onClick={onOpenAccounts}>
            Open account settings
          </NoticeButton>
        }
      >
        Both computers must be signed in to the same account.
      </Notice>
    );
  }
  return (
    <>
      {relayUnavailable ? (
        <Notice intent="attention" title="Can't reach the connection service">
          Retrying automatically. Check your internet connection.
        </Notice>
      ) : null}
      {devices.length > 0 ? (
        <>
          <p className="text-s fg-secondary">
            Choose the computer you want to control from this one.
          </p>
          <ul
            aria-label="Computers ready to pair"
            className="-mx-2 flex flex-col gap-px"
            data-testid="remote-access-pair-list"
          >
            {devices.map((device) => (
              <li key={device.deviceId}>
                <ListRow
                  disabled={busy}
                  onClick={() => onPair(device)}
                  data-testid={`remote-access-pair-option-${device.deviceId}`}
                  icon={<MacbookIcon size={16} aria-hidden="true" />}
                  trailing={platformLabel(device.platform)}
                >
                  {device.name}
                </ListRow>
              </li>
            ))}
          </ul>
        </>
      ) : discovered ? (
        <EmptyState
          testId="remote-access-pair-empty"
          inset="none"
          title="No computers ready to pair"
          subtitle="On the other computer, open Settings → Remote access and turn on Allow other computers to control this one. Both computers must be signed in to the same account."
        />
      ) : (
        <StatusLine>
          <LoadingSpinner tone="secondary" decorative />
          Looking for computers…
        </StatusLine>
      )}
    </>
  );
}

interface PairingViewProps {
  readonly pairing: RemoteOutgoingPairing;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onBack: () => void;
  readonly onOpen: () => void;
}

function renderPairing({
  pairing,
  busy,
  onCancel,
  onRetry,
  onBack,
  onOpen,
}: PairingViewProps): { body: ReactNode; footer: ReactNode } {
  const cancelButton = (
    <Button
      variant="outline"
      size="lg"
      onClick={onCancel}
      data-testid="remote-access-pair-cancel"
    >
      Cancel
    </Button>
  );
  switch (pairing.status) {
    case 'connecting':
      return {
        body: (
          <StatusLine>
            <LoadingSpinner tone="secondary" decorative />
            Connecting to {pairing.name}…
          </StatusLine>
        ),
        footer: cancelButton,
      };
    case 'awaiting-approval':
      return {
        body: (
          <div className="flex flex-col gap-4">
            <p className="text-s fg-secondary">
              Check that {pairing.name} shows the same code, then select Allow
              on that computer.
            </p>
            {pairing.code !== null ? (
              <p
                aria-label={`Pairing code ${pairing.code.split('').join(' ')}`}
                className={`${POSTHOG_REPLAY_BLOCK_CLASS} text-center font-mono text-3xl font-medium tabular-nums fg-primary`}
                data-testid="remote-access-pair-code"
              >
                {formatPairingCode(pairing.code)}
              </p>
            ) : null}
            <StatusLine>
              <LoadingSpinner tone="secondary" decorative />
              Waiting for {pairing.name}…
            </StatusLine>
          </div>
        ),
        footer: cancelButton,
      };
    case 'approved':
      return {
        body: (
          <p
            role="status"
            className="text-s fg-primary"
            data-testid="remote-access-pair-approved"
          >
            {pairing.name} is paired. You can open it any time from Computers in
            the account menu.
          </p>
        ),
        footer: (
          <>
            <Button
              variant="outline"
              size="lg"
              onClick={onCancel}
              data-testid="remote-access-pair-done"
            >
              Done
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={onOpen}
              data-testid="remote-access-pair-open"
            >
              Open {pairing.name}
            </Button>
          </>
        ),
      };
    case 'rejected':
      return {
        body: (
          <p
            role="status"
            className="text-s fg-primary"
            data-testid="remote-access-pair-rejected"
          >
            {pairing.name} declined the request.
          </p>
        ),
        footer: (
          <>
            <Button variant="outline" size="lg" onClick={onCancel}>
              Close
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={onBack}
              data-testid="remote-access-pair-back"
            >
              Choose another computer
            </Button>
          </>
        ),
      };
    case 'failed':
      return {
        body: (
          <ErrorBanner
            className=""
            testId="remote-access-pair-failed"
            error={`Couldn't pair with ${pairing.name}. ${
              pairing.error ?? 'The connection ended before it finished.'
            }`}
          />
        ),
        footer: (
          <>
            <Button variant="outline" size="lg" onClick={onCancel}>
              Close
            </Button>
            <Button
              variant="primary"
              size="lg"
              disabled={busy}
              onClick={onRetry}
              data-testid="remote-access-pair-retry"
            >
              Try again
            </Button>
          </>
        ),
      };
  }
}
