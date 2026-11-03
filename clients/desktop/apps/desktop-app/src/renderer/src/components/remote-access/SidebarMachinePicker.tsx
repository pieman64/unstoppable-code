import { useId, useRef, useState, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import {
  Dot,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  FloatingMenu,
  type DotTone,
} from '@canopy/ui-shared/components';
import {
  CheckIcon,
  ChevronDownMediumIcon,
  MacbookIcon,
  PlusIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { useGitHubStore } from '@/stores/githubStore';
import {
  ADD_COMPUTER_LABEL,
  COMPUTERS_LABEL,
  THIS_COMPUTER_LABEL,
  describeError,
  remoteHostDotTone,
  remoteHostStatus,
  type RemoteHostStatus,
} from './remote-access-copy';

export interface SidebarMachinePickerProps {
  /**
   * Re-enter the desktop sidebar's instant-feedback scope by name, as the
   * account row's menu does: the menu portals out of the sidebar's subtree.
   */
  readonly menuInstantInteractions?: boolean;
}

function StatusDot({
  tone,
  testId,
}: {
  readonly tone: DotTone;
  readonly testId: string;
}): JSX.Element {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <Dot tone={tone} data-testid={testId} />
    </span>
  );
}

interface ComputerMenuItemsProps {
  /** Close the menu the rows live in. */
  readonly onClose: () => void;
  /** Prefix for the rows' test ids, so each menu keeps its own. */
  readonly testIdPrefix: string;
  /** Separate "Add a computer…" from the computers with a divider. */
  readonly dividerBeforeAdd: boolean;
  /**
   * Check the computer the window shows. A menu that only ever appears in
   * this computer's windows leaves it out: the check would never move.
   */
  readonly showCheck: boolean;
}

/**
 * The computers on the account, then "Add a computer…": shared by the remote
 * window's picker and this computer's account menu. The computer the window
 * shows is checked. Choosing a computer opens or focuses its window; choosing
 * this computer focuses the main window.
 */
function ComputerMenuItems({
  onClose,
  testIdPrefix,
  dividerBeforeAdd,
  showCheck,
}: ComputerMenuItemsProps): JSX.Element {
  const { context, state, openMachine, openPairDialog } = useRemoteControlStore(
    useShallow((store) => ({
      context: store.context,
      state: store.state,
      openMachine: store.openMachine,
      openPairDialog: store.openPairDialog,
    })),
  );
  const shownId = context.mode === 'remote' ? context.deviceId : null;
  const thisName = state.thisDevice?.name ?? THIS_COMPUTER_LABEL;

  const choose = (deviceId: string | null): void => {
    onClose();
    // Choosing the computer already shown only matters to reconnect it.
    const shownHost =
      shownId === null
        ? null
        : (state.hosts.find((host) => host.deviceId === shownId) ?? null);
    const reconnectable =
      shownHost !== null &&
      (shownHost.connection === 'error' || shownHost.connection === 'idle');
    if (deviceId === shownId && !reconnectable) return;
    void openMachine(deviceId).catch((cause: unknown) => {
      useGitHubStore
        .getState()
        .addToast(
          describeError(cause, "Couldn't open that computer. Try again."),
          'error',
        );
    });
  };

  return (
    <>
      <DropdownMenuItem
        role="menuitemradio"
        aria-checked={shownId === null}
        data-testid={`${testIdPrefix}-option-local`}
        onClick={() => choose(null)}
      >
        <DropdownMenuItemIcon>
          <MacbookIcon size={16} aria-hidden="true" />
        </DropdownMenuItemIcon>
        <span className="min-w-0 flex-1 truncate" title={thisName}>
          {thisName}
        </span>
        <span className="shrink-0 text-xs fg-secondary">
          {THIS_COMPUTER_LABEL}
        </span>
        {showCheck && shownId === null ? (
          <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
        ) : null}
      </DropdownMenuItem>
      {state.hosts.map((host) => {
        const selected = shownId === host.deviceId;
        const status = remoteHostStatus(host);
        return (
          <DropdownMenuItem
            key={host.deviceId}
            role="menuitemradio"
            aria-checked={selected}
            aria-label={`${host.name}, ${status.label}`}
            data-testid={`${testIdPrefix}-option-${host.deviceId}`}
            onClick={() => choose(host.deviceId)}
          >
            <DropdownMenuItemIcon>
              <MacbookIcon size={16} aria-hidden="true" />
            </DropdownMenuItemIcon>
            <span className="min-w-0 flex-1 truncate" title={host.name}>
              {host.name}
            </span>
            <span className="shrink-0 text-xs fg-secondary">
              {status.label}
            </span>
            {showCheck && selected ? (
              <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
            ) : null}
          </DropdownMenuItem>
        );
      })}
      {dividerBeforeAdd ? <DropdownMenuDivider /> : null}
      <DropdownMenuItem
        data-testid={`${testIdPrefix}-add`}
        onClick={() => {
          onClose();
          openPairDialog();
        }}
      >
        <DropdownMenuItemIcon>
          <PlusIcon size={16} aria-hidden="true" />
        </DropdownMenuItemIcon>
        <span className="min-w-0 flex-1 truncate">{ADD_COMPUTER_LABEL}</span>
      </DropdownMenuItem>
    </>
  );
}

/**
 * The computers section of this computer's account menu, under the
 * Personal/organization accounts. This computer's sidebar has no picker, so
 * switching to a paired computer starts here. Rendered only in this
 * computer's own windows while remote access is available and signed in;
 * ends with a divider before the next section.
 */
export function AccountMenuComputersSection({
  onClose,
}: {
  readonly onClose: () => void;
}): JSX.Element | null {
  const { local, ready } = useRemoteControlStore(
    useShallow((store) => ({
      local: store.context.mode === 'local',
      ready: store.state.available && store.state.signedIn,
    })),
  );
  if (!local || !ready) return null;
  return (
    <>
      <div
        data-testid="sidebar-account-menu-computers-label"
        className="pb-1 pl-2 pr-1 pt-1 text-xs fg-tertiary"
      >
        {COMPUTERS_LABEL}
      </div>
      <div
        data-testid="sidebar-account-menu-computers"
        className="flex flex-col gap-px"
      >
        <ComputerMenuItems
          onClose={onClose}
          testIdPrefix="sidebar-account-menu-computer"
          dividerBeforeAdd={false}
          showCheck={false}
        />
      </div>
      <DropdownMenuDivider />
    </>
  );
}

/**
 * Which computer a remote window shows, pinned above the account row beside
 * the Personal/organization picker: both answer "whose work am I looking at".
 *
 * Only a window opened for a paired computer renders it, with the
 * connection's status dot on the trigger. This computer's own windows reach
 * the same computers from the account menu instead
 * ({@link AccountMenuComputersSection}), so their sidebar looks as it does
 * with remote access off.
 */
export function SidebarMachinePicker({
  menuInstantInteractions = false,
}: SidebarMachinePickerProps): JSX.Element | null {
  const { context, state } = useRemoteControlStore(
    useShallow((store) => ({
      context: store.context,
      state: store.state,
    })),
  );
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  if (!state.available || !state.signedIn || context.mode !== 'remote') {
    return null;
  }

  const remote = context;
  const currentHost =
    state.hosts.find((host) => host.deviceId === remote.deviceId) ?? null;
  const currentLabel = currentHost?.name ?? remote.name;
  // The trigger reports this window's own connection; the host row may be
  // missing for a moment after a removal, which reads as not connected.
  const currentStatus: RemoteHostStatus = remoteHostStatus(
    currentHost ?? { online: false, connection: 'error' },
  );
  const currentDot = remoteHostDotTone(currentStatus.tone);
  const triggerLabel = `Computer: ${currentLabel}, ${currentStatus.label}`;

  const close = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className="relative w-full min-w-0">
      <div ref={rowRef} className="flex w-full items-center gap-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((value) => !value)}
          data-testid="sidebar-machine-picker"
          data-machine-mode="remote"
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-label={triggerLabel}
          className="focus-ring flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-row px-2 text-left text-s font-normal fg-primary hover:bg-subtle pointer-coarse:min-h-11"
        >
          <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center fg-secondary">
            <MacbookIcon size={16} aria-hidden="true" />
          </span>
          <span
            className="min-w-0 flex-1 truncate leading-snug"
            title={currentLabel}
          >
            {currentLabel}
          </span>
          {currentDot ? (
            <StatusDot
              tone={currentDot}
              testId="sidebar-machine-picker-status"
            />
          ) : null}
          <ChevronDownMediumIcon
            size={16}
            aria-hidden="true"
            className="shrink-0 fg-secondary"
          />
        </button>
      </div>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={rowRef}
        returnFocusRef={triggerRef}
        placement="top-left"
        aria-label="Switch computer"
        data-testid="sidebar-machine-picker-menu"
        className={
          menuInstantInteractions ? 'sidebar-instant-interactions w-64' : 'w-64'
        }
        closeOnSelect={false}
      >
        <ComputerMenuItems
          onClose={close}
          testIdPrefix="sidebar-machine"
          dividerBeforeAdd
          showCheck
        />
      </FloatingMenu>
    </div>
  );
}
