import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  BrowserProfileBadge,
  Button,
  ChevronDownIcon,
  CloseButton,
  Notice,
  SettingsIcon,
  Tooltip,
  getMeasuredBadgePopoverPosition,
} from '@canopy/ui-shared';
import type {
  BrowserProfileRecord,
  BrowserTaskSlot,
  BrowserProfileSelection,
} from '@canopy/protocol/browser-profiles';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types';
import { useBrowserStore } from '@/stores/browserStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import {
  browserProfileDisplayName,
  collidingProfileNames,
  profileNameQualifier,
} from '@/lib/browserProfileNames';

/** Shown when a profile switch is cancelled before it applies. */
export const PROFILE_SWITCH_CANCELLED =
  'Profile switch cancelled. The original page is still open.';

/** Why another control opened the picker: shown once it opens. */
export interface BrowserProfilePickerReason {
  readonly notice?: string;
  readonly error?: string;
}

interface BrowserProfilePickerProps {
  snapshot: BrowserSessionSnapshot;
  /**
   * Opened by another control (the early-access address bar's menu) instead
   * of its own chip: no chip renders, the popover anchors to `anchorRef`, and
   * `open` / `onOpenChange` own its visibility.
   */
  control?: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly anchorRef: RefObject<HTMLElement | null>;
    /** Why it opened (a profile switch that needs attention), if anything. */
    readonly reason?: BrowserProfilePickerReason;
  };
}

export function BrowserProfilePicker({
  snapshot,
  control,
}: BrowserProfilePickerProps): JSX.Element {
  const [ownOpen, setOwnOpen] = useState(false);
  const anchorRef = control?.anchorRef;
  const onOpenChange = control?.onOpenChange;
  const open = control ? control.open : ownOpen;
  const setOpen = useCallback(
    (next: boolean): void => {
      if (onOpenChange) onOpenChange(next);
      else setOwnOpen(next);
    },
    [onOpenChange],
  );
  const [profiles, setProfiles] = useState<BrowserProfileRecord[]>([]);
  const [slot, setSlot] = useState<BrowserTaskSlot>();
  const [selected, select] = useState('task');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [nextOffset, setNextOffset] = useState<number>();
  const selectId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 8, left: 8 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = (): void => {
      const anchor = anchorRef?.current ?? button.current;
      if (!anchor || !menu.current) return;
      setPosition(
        getMeasuredBadgePopoverPosition(
          anchor.getBoundingClientRect(),
          menu.current.offsetHeight,
          menu.current.offsetWidth,
        ),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return (): void => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef, open]);
  // Dismiss on a pointer press outside the popover, the way every other
  // anchored surface behaves. Without it the only ways out are Escape and
  // completing an action, so a mis-click leaves the menu floating over the
  // page. Skipped while an operation is in flight: closing mid-switch would
  // hide the progress and error the user still needs to see.
  useEffect(() => {
    if (!open || busy) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        menu.current?.contains(target) ||
        button.current?.contains(target) ||
        anchorRef?.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchorRef, open, busy, setOpen]);
  const scope = {
    projectId: snapshot.projectId,
    worktreeId: snapshot.worktreeId,
  };
  const selection: BrowserProfileSelection =
    selected === 'task'
      ? { kind: 'task' }
      : { kind: 'named', profileId: selected };
  /** The profile this tab is using right now, in `<select>` value form. */
  const currentValue =
    snapshot.profile?.selection.kind === 'named'
      ? snapshot.profile.resolvedProfileId
      : 'task';
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const load = (): void => {
    setNotice('');
    select(currentValue);
    void run(async () => {
      const [page, context] = await Promise.all([
        window.api.browser.profiles.list(scope),
        window.api.browser.profiles.context(scope),
      ]);
      setProfiles(page.profiles);
      setNextOffset(page.nextOffset);
      setSlot(context);
    });
  };
  const show = (): void => {
    setOpen(true);
    load();
  };
  // Opened from outside: load the profiles each time it opens.
  const controlledOpen = control?.open === true;
  const openReason = control?.reason;
  useEffect(() => {
    if (!controlledOpen) return;
    load();
    // After `load` clears the notice and error, so the reason survives it.
    if (openReason?.notice) setNotice(openReason.notice);
    if (openReason?.error) setError(openReason.error);
    // `load` reads the latest snapshot; re-running on its identity would
    // reload on every render while open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledOpen]);
  const close = (): void => {
    setOpen(false);
    (anchorRef?.current ?? button.current)?.focus();
  };
  const switchTo = (mode: 'replace' | 'new-tab'): void => {
    if (!snapshot.profile) {
      setError('Wait for this browser to finish opening.');
      return;
    }
    const expectedRuntimeGeneration = snapshot.profile.runtimeGeneration;
    void run(async () => {
      const result = await window.api.browser.switchProfile({
        operationId: crypto.randomUUID(),
        browserId: snapshot.id,
        expectedRuntimeGeneration,
        selection,
        mode,
      });
      const store = useBrowserStore.getState();
      if (mode === 'new-tab' && result.status === 'complete') {
        store.registerBrowserSnapshot(result.browser);
        const activated = await requestBrowserPanel(
          snapshot.projectId,
          snapshot.worktreeId,
          result.browser.id,
        );
        if (!activated) {
          await window.api.browser.destroy({ browserId: result.browser.id });
          store.dropBrowserSession(
            snapshot.projectId,
            snapshot.worktreeId,
            result.browser.id,
          );
          throw new Error(
            'The new browser panel could not be placed. The original tab is unchanged.',
          );
        }
      } else store.applySnapshot(result.browser);
      if (result.message) setNotice(result.message);
      else if (result.status === 'cancelled')
        setNotice(PROFILE_SWITCH_CANCELLED);
      else close();
    });
  };
  const defaultSelection = slot?.defaultSelection;
  /**
   * Both action groups are hidden when they would be a no-op.
   *
   * Picking the profile a tab already uses and pressing Replace reloads the
   * page for nothing, and pressing "use for new tabs" when it is already the
   * default writes an unchanged record. Offering either is offering a control
   * that cannot do anything.
   *
   * `defaultValue` stays `undefined` until the task slot loads, so the footer
   * action waits for a real answer rather than flashing on an assumption.
   */
  const switchChangesProfile = selected !== currentValue;
  const defaultValue = defaultSelection
    ? defaultSelection.kind === 'named'
      ? defaultSelection.profileId
      : 'task'
    : undefined;
  const defaultChangesProfile =
    defaultValue !== undefined && selected !== defaultValue;
  const currentName = browserProfileDisplayName(snapshot);
  const colliding = collidingProfileNames(profiles);
  const defaultName =
    defaultSelection?.kind === 'named'
      ? (profiles.find(
          (profile) => profile.profileId === defaultSelection.profileId,
        )?.displayName ?? 'Unavailable profile')
      : 'Task';
  return (
    <>
      {control ? null : (
        <>
          {/* Suppressed while the popover is open: the pointer is still over the
          trigger after the click, so the tooltip would otherwise paint on top
          of the menu it just opened. */}
          <Tooltip label={`Browser profile: ${currentName}`} suppressed={open}>
            <button
              ref={button}
              type="button"
              aria-label={`Browser profile: ${currentName}`}
              aria-expanded={open}
              aria-haspopup="dialog"
              data-testid="browser-profile-picker"
              onClick={show}
              className={`browser-bar-pick-button min-w-0 ${
                open
                  ? 'bg-muted/60 fg-primary'
                  : 'fg-secondary hover:bg-muted/40 hover:fg-primary'
              }`}
            >
              <BrowserProfileBadge
                name={currentName}
                color={snapshot.profileInfo?.color}
                className="max-w-28"
                titleSuppressed
              />
              <ChevronDownIcon aria-hidden="true" className="shrink-0" />
            </button>
          </Tooltip>
        </>
      )}
      {open &&
        createPortal(
          <div
            ref={menu}
            style={position}
            role="dialog"
            aria-label="Choose browser profile"
            aria-modal="false"
            data-testid="browser-profile-menu"
            data-canopy-browser-native-overlay="true"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !busy) {
                event.stopPropagation();
                close();
              }
            }}
            className="fixed z-dropdown flex max-h-[calc(100vh-16px)] w-80 max-w-[calc(100vw-16px)] flex-col gap-4 overflow-y-auto rounded-xl bg-popover p-4 shadow-lg"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-s font-medium fg-primary">
                  Browser profile
                </h3>
                {switchChangesProfile && (
                  <p className="mt-1 text-xs fg-secondary">
                    Replacing reloads this tab in the selected profile. Unsaved
                    changes may be lost, and other tabs keep their profiles.
                  </p>
                )}
              </div>
              <CloseButton onClick={close} />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs fg-secondary" htmlFor={selectId}>
                Use profile
              </label>
              <select
                autoFocus
                id={selectId}
                aria-label="Use profile"
                data-testid="browser-profile-selection"
                value={selected}
                onChange={(event) => select(event.target.value)}
                disabled={busy}
                className="focus-ring w-full cursor-pointer appearance-none rounded-lg border bg-base px-3 py-1.5 text-s fg-primary disabled:cursor-default disabled:opacity-60"
              >
                <option value="task">Task (this task only)</option>
                {selected !== 'task' &&
                  !profiles.some(
                    (profile) => profile.profileId === selected,
                  ) && <option value={selected}>Unavailable profile</option>}
                {profiles
                  .filter((profile) => profile.kind === 'named')
                  .map((profile) => {
                    const qualifier = profileNameQualifier(profile, colliding);
                    return (
                      <option key={profile.profileId} value={profile.profileId}>
                        {qualifier
                          ? `${profile.displayName} · ${qualifier}`
                          : profile.displayName}
                      </option>
                    );
                  })}
              </select>
              {nextOffset !== undefined && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  className="-ml-2.5"
                  onClick={() =>
                    void run(async () => {
                      const page = await window.api.browser.profiles.list({
                        ...scope,
                        offset: nextOffset,
                      });
                      setProfiles((current) => [...current, ...page.profiles]);
                      setNextOffset(page.nextOffset);
                    })
                  }
                >
                  Load more profiles
                </Button>
              )}
            </div>
            {switchChangesProfile && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="md"
                  data-testid="browser-profile-replace"
                  disabled={busy}
                  onClick={() => switchTo('replace')}
                >
                  Replace this tab
                </Button>
                <Button
                  variant="outline"
                  size="md"
                  data-testid="browser-profile-new-tab"
                  disabled={busy}
                  onClick={() => switchTo('new-tab')}
                >
                  Open new tab
                </Button>
              </div>
            )}
            {/* Stacked rather than a justify-between row: at this width the
                button wraps, and a wrapped `justify-between` child lands
                inset by its own padding instead of on the popover's edge. */}
            <div className="flex flex-col items-start gap-0.5 border-t pt-3">
              <p className="min-w-0 text-xs fg-secondary">
                New-tab default:{' '}
                <span className="fg-primary">{defaultName}</span>
              </p>
              {defaultChangesProfile && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="browser-profile-set-default"
                  disabled={busy || !slot}
                  className="-ml-2.5"
                  onClick={() =>
                    slot &&
                    void run(async () => {
                      setSlot(
                        await window.api.browser.profiles.setDefault({
                          ...scope,
                          operationId: crypto.randomUUID(),
                          incarnationId: slot.incarnationId,
                          expectedMetadataRevision: slot.metadataRevision,
                          selection,
                        }),
                      );
                      setNotice(
                        'Default updated for new tabs in this task. Existing tabs keep their profiles.',
                      );
                    })
                  }
                >
                  Use selected for new tabs
                </Button>
              )}
            </div>
            {/* Everything above acts on this tab; this leaves for the page
                that owns profiles themselves (create, rename, permissions,
                stored data), so it sits below its own rule. */}
            <div className="border-t pt-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid="browser-profile-open-settings"
                className="-ml-2.5"
                onClick={() => {
                  setOpen(false);
                  useNavigationStore.getState().openSettings('browser');
                }}
              >
                <SettingsIcon className="shrink-0" />
                Settings
              </Button>
            </div>
            {busy && (
              <Notice intent="neutral" title="Applying profile">
                Respond to any page dialog to continue.
              </Notice>
            )}
            {error && <Notice intent="destructive">{error}</Notice>}
            {notice && <Notice intent="neutral">{notice}</Notice>}
          </div>,
          document.body,
        )}
    </>
  );
}
