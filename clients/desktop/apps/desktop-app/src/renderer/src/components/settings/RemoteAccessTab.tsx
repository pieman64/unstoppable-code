import { useState, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  Button,
  ConfirmDialog,
  Notice,
  NoticeButton,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import type {
  RemoteControlController,
  RemoteControlHost,
} from '@canopy/desktop-shared/types';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import {
  ADD_COMPUTER_LABEL,
  CONTROL_RISK_SENTENCE,
  REMOTE_ACCESS_LABEL,
  describeError,
  platformLabel,
  remoteHostDotClassName,
  remoteHostStatus,
} from '@/components/remote-access/remote-access-copy';
import {
  SettingsGroup,
  SettingsPage,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from './SettingsLayout';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';

type PendingRemoval =
  | { readonly role: 'host'; readonly device: RemoteControlHost }
  | { readonly role: 'controller'; readonly device: RemoteControlController };

/**
 * Settings → Remote access: whether other computers on the account may
 * control this one, the computers this one can control, and the computers
 * that can control it. Main owns every value; each action returns the new
 * state, which the store applies.
 */
export function RemoteAccessTab(): JSX.Element {
  const {
    hydrated,
    state,
    setAllowIncoming,
    openMachine,
    forgetDevice,
    disconnectController,
    openPairDialog,
  } = useRemoteControlStore(
    useShallow((store) => ({
      hydrated: store.hydrated,
      state: store.state,
      setAllowIncoming: store.setAllowIncoming,
      openMachine: store.openMachine,
      forgetDevice: store.forgetDevice,
      disconnectController: store.disconnectController,
      openPairDialog: store.openPairDialog,
    })),
  );
  const [savingAllow, setSavingAllow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyDevice, setBusyDevice] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(
    null,
  );
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const page = (children: ReactNode): JSX.Element => (
    <SettingsPage
      title={REMOTE_ACCESS_LABEL}
      description="Control your other computers from this one, or let them control it."
      dataTestId="settings-tab-remote-access"
    >
      {children}
    </SettingsPage>
  );

  if (!hydrated) {
    return page(<SettingsLoading variant="spinner" />);
  }

  if (!state.signedIn) {
    return page(
      <Notice
        intent="attention"
        title="Sign in to pair computers"
        data-testid="settings-remote-access-signed-out"
        actions={
          <NoticeButton
            variant="primary"
            onClick={() => openCloudAccountSettings()}
          >
            Open account settings
          </NoticeButton>
        }
      >
        Every computer you pair must be signed in to the same account.
      </Notice>,
    );
  }

  const run = (deviceId: string, action: () => Promise<void>): void => {
    setBusyDevice(deviceId);
    setError(null);
    void action()
      .catch((cause: unknown) => {
        setError(describeError(cause, 'Something went wrong. Try again.'));
      })
      .finally(() => setBusyDevice(null));
  };

  const toggleAllow = (next: boolean): void => {
    setSavingAllow(true);
    setError(null);
    void setAllowIncoming(next)
      .catch((cause: unknown) => {
        setError(describeError(cause, "Couldn't save the setting. Try again."));
      })
      .finally(() => setSavingAllow(false));
  };

  const confirmRemoval = (): void => {
    if (!pendingRemoval) return;
    setRemoving(true);
    setRemoveError(null);
    void forgetDevice({
      deviceId: pendingRemoval.device.deviceId,
      role: pendingRemoval.role,
    })
      .then(() => setPendingRemoval(null))
      .catch((cause: unknown) => {
        setRemoveError(describeError(cause, "Couldn't remove the computer."));
      })
      .finally(() => setRemoving(false));
  };

  return page(
    <>
      {state.relayStatus === 'unavailable' ? (
        <Notice
          intent="attention"
          title="Can't reach the connection service"
          data-testid="settings-remote-access-unavailable"
        >
          Paired computers can't connect until it's back. Retrying
          automatically.
        </Notice>
      ) : null}
      {error ? (
        <Notice intent="destructive" data-testid="settings-remote-access-error">
          {error}
        </Notice>
      ) : null}

      <SettingsSection title="This computer">
        <SettingsGroup>
          <SettingsRow
            label="Allow other computers to control this one"
            description={`A paired computer ${CONTROL_RISK_SENTENCE}. Each new pairing needs your approval on this computer.`}
            htmlFor="settings-remote-access-allow-incoming"
            dataTestId="settings-remote-access-allow-row"
            control={
              <ToggleSwitch
                id="settings-remote-access-allow-incoming"
                checked={state.allowIncoming}
                label="Allow other computers to control this one"
                dataTestId="settings-remote-access-allow-incoming"
                disabled={savingAllow}
                onChange={toggleAllow}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection
        title="Computers you can control"
        dataTestId="settings-remote-access-hosts"
      >
        <SettingsGroup>
          {state.hosts.map((host) => {
            const status = remoteHostStatus(host);
            const dot = remoteHostDotClassName(status.tone);
            return (
              <SettingsRow
                key={host.deviceId}
                dataTestId={`settings-remote-access-host-${host.deviceId}`}
                label={
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <span className="truncate">{host.name}</span>
                    {dot ? (
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`}
                      />
                    ) : null}
                  </span>
                }
                description={
                  host.connection === 'error' && host.error
                    ? `${platformLabel(host.platform)} · ${status.label}. ${host.error}`
                    : `${platformLabel(host.platform)} · ${status.label}`
                }
                control={
                  <>
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={busyDevice === host.deviceId}
                      onClick={() => {
                        setRemoveError(null);
                        setPendingRemoval({ role: 'host', device: host });
                      }}
                      data-testid={`settings-remote-access-host-remove-${host.deviceId}`}
                    >
                      Remove
                    </Button>
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={busyDevice === host.deviceId}
                      onClick={() =>
                        run(host.deviceId, () => openMachine(host.deviceId))
                      }
                      data-testid={`settings-remote-access-host-open-${host.deviceId}`}
                    >
                      Open
                    </Button>
                  </>
                }
              />
            );
          })}
          <SettingsRow
            label={
              state.hosts.length === 0
                ? 'Pair a computer'
                : 'Pair another computer'
            }
            description="On the other computer, turn on Allow other computers to control this one. Both must be signed in to the same account."
            dataTestId="settings-remote-access-add-row"
            control={
              <Button
                size="compact"
                variant="secondary"
                onClick={openPairDialog}
                data-testid="settings-remote-access-add"
              >
                {ADD_COMPUTER_LABEL}
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      {state.controllers.length > 0 ? (
        <SettingsSection
          title="Computers that can control this one"
          dataTestId="settings-remote-access-controllers"
        >
          <SettingsGroup>
            {state.controllers.map((controller) => (
              <SettingsRow
                key={controller.deviceId}
                dataTestId={`settings-remote-access-controller-${controller.deviceId}`}
                label={controller.name}
                description={`${platformLabel(controller.platform)} · ${
                  controller.connected
                    ? 'Controlling now'
                    : controller.online
                      ? 'Online'
                      : 'Offline'
                }`}
                control={
                  <>
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={busyDevice === controller.deviceId}
                      onClick={() => {
                        setRemoveError(null);
                        setPendingRemoval({
                          role: 'controller',
                          device: controller,
                        });
                      }}
                      data-testid={`settings-remote-access-controller-remove-${controller.deviceId}`}
                    >
                      Remove
                    </Button>
                    {controller.connected ? (
                      <Button
                        size="compact"
                        variant="secondary"
                        disabled={busyDevice === controller.deviceId}
                        onClick={() =>
                          run(controller.deviceId, () =>
                            disconnectController(controller.deviceId),
                          )
                        }
                        data-testid={`settings-remote-access-controller-disconnect-${controller.deviceId}`}
                      >
                        Disconnect
                      </Button>
                    ) : null}
                  </>
                }
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      ) : null}

      {pendingRemoval ? (
        <ConfirmDialog
          title={`Remove ${pendingRemoval.device.name}?`}
          message={
            pendingRemoval.role === 'host'
              ? `You won't be able to open ${pendingRemoval.device.name} from here until you pair it again.`
              : `${pendingRemoval.device.name} won't be able to control this computer, and control ends now if it's connected. It needs your approval to pair again.`
          }
          confirmLabel="Remove computer"
          busyLabel="Removing…"
          busy={removing}
          errorMessage={removeError}
          destructive
          onConfirm={confirmRemoval}
          onCancel={() => setPendingRemoval(null)}
          confirmTestId="settings-remote-access-remove-confirm"
          dataTestId="settings-remote-access-remove-dialog"
        />
      ) : null}
    </>,
  );
}
