import { useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { MacbookIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { RemoteControlController } from '@canopy/desktop-shared/types';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { describeError } from './remote-access-copy';

/**
 * Persistent notice in this computer's own windows while a paired computer
 * controls it, one per controlling computer, with a way to end the session.
 * Mounted in the in-app notification column; it renders nothing in a window
 * that shows another computer.
 */
export function RemoteAccessControlledNotice(): JSX.Element | null {
  const { local, controllers } = useRemoteControlStore(
    useShallow((store) => ({
      local: store.context.mode === 'local',
      controllers: store.state.controllers,
    })),
  );
  if (!local) return null;
  const connected = controllers.filter((controller) => controller.connected);
  if (connected.length === 0) return null;
  return (
    <>
      {connected.map((controller) => (
        <ControlledNoticeRow
          key={controller.deviceId}
          controller={controller}
        />
      ))}
    </>
  );
}

function ControlledNoticeRow({
  controller,
}: {
  readonly controller: RemoteControlController;
}): JSX.Element {
  const disconnectController = useRemoteControlStore(
    (s) => s.disconnectController,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const disconnect = (): void => {
    setBusy(true);
    setError(null);
    void disconnectController(controller.deviceId)
      .catch((cause: unknown) => {
        setError(describeError(cause, "Couldn't disconnect. Try again."));
      })
      .finally(() => setBusy(false));
  };

  return (
    <Notice
      intent="attention"
      icon={<MacbookIcon size={16} aria-hidden="true" />}
      title={`${controller.name} is controlling this computer`}
      detail={error ?? undefined}
      className="pointer-events-auto"
      data-testid="remote-access-controlled-notice"
      data-device-id={controller.deviceId}
      actions={
        <NoticeButton
          disabled={busy}
          onClick={disconnect}
          data-testid="remote-access-controlled-notice-disconnect"
        >
          Disconnect
        </NoticeButton>
      }
    >
      It can see and change everything here.
    </Notice>
  );
}
