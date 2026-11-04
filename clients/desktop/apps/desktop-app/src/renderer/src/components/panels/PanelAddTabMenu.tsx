/**
 * PanelAddTabMenu — the desktop add-panel menu opened by a group's
 * `panel-add-tab-${groupId}` button (doc-09 §2.7: `panel-add-menu` /
 * `panel-add-menu-item-${kind}`).
 *
 * Rendered by WorktreePart through the shared `PanelTabBarAddTab.menu` slot,
 * so its REACT parent is the button's anchored wrapper
 * (`.canopy-panel-add-tab-root`) — but the menu DOM itself portals into the
 * host `document.body` through the shared floating layer, escaping grid-leaf
 * clipping while retaining owner-window collision sizing and focus return.
 * Long catalogs scroll within the available height. A leading "New Chat"
 * entry creates a fresh chatStore tab and places its bound panel in the menu's
 * own group (ahead of the sync bridge's MRU placement). A "Plans" entry after
 * Terminal opens or reveals the plans list card — a plain row, or, once the
 * owning worktree has visible tracked plans, a submenu of `All plans` and
 * each plan (`usePlansAddMenuSection`).
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  PanelAddTabMenuView,
  type PanelAddTabMenuViewEntry,
} from '@canopy/ui-shared/components/panels';
import { CHAT_UNIT_LABEL, type PanelKind } from '@canopy/protocol';
import type {
  TerminalPreset,
  TerminalShellProfile,
  TerminalShellProfileId,
} from '@canopy/desktop-shared/types';
import {
  WorkflowsIcon,
  BarChart4BarsIcon,
  ChatIcon,
  DataUsageIcon,
  FilesIcon,
  SettingsIcon,
  TerminalIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  addChatPanelToGroup,
  addEmptyFileTabPanelToGroup,
} from '@/lib/panels/addChatPanel';
import {
  getCachedTerminalShellProfiles,
  getCachedTerminalPanelPreferences,
  loadTerminalPanelPreferences,
  loadTerminalShellProfiles,
} from '@/lib/terminalShellProfiles';
import {
  getAuxPanelLayoutOwnerKey,
  isAuxPanelLayoutKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { DEFAULT_CHAT_GROUP_ID } from '@/lib/panels/panel-group-ids';
import { isSharedContainerViewerLayout } from '@/lib/panels/shared-container-viewer-layout';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import {
  listAddablePanels,
  type AddablePanelEntry,
} from '@/lib/panels/registry';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { isActivitySectionAllowedForAccess } from '@/lib/shared-containers/panel-allowlist';
import { LoadingSpinner } from '@/components/shared/loading';
import {
  createBrowserPanel,
  createTerminalPanel,
} from '@/lib/panels/panel-creation-actions';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  TerminalDefaultShellBadge,
  TERMINAL_DEFAULT_SHELL_TOOLTIP,
} from '@/components/terminal/TerminalDefaultShellBadge';
import { useTerminalPresetColorMode } from '@/hooks/useTerminalPresetColorMode';
import { resolveTerminalPresetImageDataUrl } from '@/lib/terminalPresetIcons';
import { usePlansAddMenuSection } from './usePlansAddMenuSection';
import {
  openSubagentsPanel,
  type SubagentPanelScope,
} from '@/lib/panels/subagent-panel-open';
import { earlyAccessTitle } from '@/lib/earlyAccessTitles';

export interface PanelAddTabMenuProps {
  /** The group the menu adds a tab to (menu items report it for context). */
  groupId: string;
  /** Worktree layout key the addable catalog is resolved against. */
  worktreeKey: string;
  /**
   * Invoked with the chosen entry's kind plus (for instance-bound entries)
   * its entity binding and display title; the caller adds the tab + closes.
   */
  onSelect: (
    kind: PanelKind,
    opts?: {
      readonly instance?: Readonly<Record<string, string>>;
      readonly title?: string;
    },
  ) => void;
  /** Dismissal request (outside mousedown / Escape). */
  onClose: () => void;
  /**
   * Panel kinds to omit from the catalog. Used by surfaces whose backend
   * cannot host a kind yet (e.g. the App Advisor popout hides `browser`
   * until main-process browser host ownership lands).
   */
  excludeKinds?: readonly PanelKind[];
}

/**
 * Test-id suffix for instance-bound entries: `-${sectionId}` for activity
 * cards, `-${variant}` for usage variants, `-${chatTabId}` / `-${fileTabId}`
 * for chat/file entries, and `-${chatId}` for Session breakdown entries.
 * Singleton entries keep the bare
 * `panel-add-menu-item-${kind}` id.
 */
function entryTestId(entry: AddablePanelEntry): string {
  const suffix =
    entry.instance?.sectionId ??
    entry.instance?.variant ??
    entry.instance?.chatTabId ??
    entry.instance?.chatId ??
    entry.instance?.fileTabId;
  return suffix !== undefined
    ? `panel-add-menu-item-${entry.kind}-${suffix}`
    : `panel-add-menu-item-${entry.kind}`;
}

/** The owning project/worktree for a main or auxiliary menu layout key. */
function subagentPanelScopeForLayoutKey(
  layoutKey: string,
): SubagentPanelScope | null {
  const ownerKey = getAuxPanelLayoutOwnerKey(layoutKey) ?? layoutKey;
  const separator = ownerKey.indexOf('/');
  if (separator <= 0 || separator === ownerKey.length - 1) return null;
  return {
    projectId: ownerKey.slice(0, separator),
    worktreeId: ownerKey.slice(separator + 1),
  };
}

export function PanelAddTabMenu({
  groupId,
  worktreeKey,
  onSelect,
  onClose,
  excludeKinds: requestedExcludeKinds,
}: PanelAddTabMenuProps): JSX.Element {
  // Early access keeps chats in the main chat group (early-access-panel-rules),
  // so every other group of a layout that has one offers no chats.
  const earlyAccess = useLabsExperimentEnabled('activity-card');
  const chatsBelongElsewhere = usePanelLayoutStore(
    (state) =>
      earlyAccess &&
      groupId !== DEFAULT_CHAT_GROUP_ID &&
      state.layouts[worktreeKey]?.groups[DEFAULT_CHAT_GROUP_ID] !== undefined,
  );
  const excludeKinds = useMemo(
    (): readonly PanelKind[] | undefined =>
      chatsBelongElsewhere
        ? [...(requestedExcludeKinds ?? []), 'chat']
        : requestedExcludeKinds,
    [chatsBelongElsewhere, requestedExcludeKinds],
  );
  const terminalPresetColorMode = useTerminalPresetColorMode();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    setAnchor(anchorRef.current?.parentElement ?? null);
  }, []);

  // "New Chat" creates a fresh chatStore tab AND immediately materializes its
  // bound panel in THIS group, so placement lands where the user clicked `+`.
  // The chat ⇄ panel sync bridge reconciles on a microtask and skips instance
  // keys that already have a panel, so adding the panel synchronously here
  // (same task as `createTab`) wins over the bridge's MRU placement; the
  // bridge's active-tab sweep then just focuses the panel we placed.
  const handleNewChat = (): void => {
    addChatPanelToGroup(worktreeKey, groupId);
  };

  // "File" creates an EMPTY file tab (picker state,
  // embedded tree expanded) and binds its panel into THIS group.
  const handleNewFileTab = (): void => {
    addEmptyFileTabPanelToGroup(worktreeKey, groupId);
  };

  // Repeatable Browser add: selecting the always-present `Browser` row first
  // creates a blank backend session, then inserts a bound panel with
  // `{ browserId }` into THIS group. Transactional: the menu closes only
  // after the panel is successfully bound; on failure only the freshly
  // created session is destroyed (never a pre-existing one), the menu stays
  // usable, and a toast reports the failure. While the create is in flight
  // the row is disabled with the existing spinner and `aria-busy`.
  const [browserAddBusy, setBrowserAddBusy] = useState(false);
  // Seed from the shared cache so a warm open paints the COMPLETE row list
  // immediately. Fetching straight into empty state made "Terminal (bash)"
  // (and any other profile) appear a beat after the menu opened, shifting
  // every row below it out from under the cursor.
  const [terminalProfiles, setTerminalProfiles] = useState<
    TerminalShellProfile[]
  >(() => getCachedTerminalShellProfiles() ?? []);
  const [terminalPreferences, setTerminalPreferences] = useState(
    () =>
      getCachedTerminalPanelPreferences() ?? {
        disabledTerminalShellProfileIds: [],
        terminalPresets: [],
      },
  );
  const [terminalAddBusy, setTerminalAddBusy] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    void Promise.all([
      loadTerminalShellProfiles(),
      loadTerminalPanelPreferences(),
    ]).then(([profiles, preferences]) => {
      if (canceled) return;
      setTerminalProfiles(profiles);
      setTerminalPreferences(preferences);
    });
    return (): void => {
      canceled = true;
    };
  }, []);

  const terminalShellRows = useMemo(() => {
    return terminalProfiles
      .map((profile) => ({
        profile,
        label: profile.label,
      }))
      .filter(
        ({ profile }) =>
          !terminalPreferences.disabledTerminalShellProfileIds.includes(
            profile.id,
          ),
      );
  }, [terminalPreferences.disabledTerminalShellProfileIds, terminalProfiles]);

  const enabledTerminalPresets = useMemo(
    () =>
      terminalPreferences.terminalPresets.filter((preset) => preset.enabled),
    [terminalPreferences.terminalPresets],
  );

  const handleAddTerminal = (
    busyKey: string,
    terminalProfileId: TerminalShellProfileId,
    title: string,
    command?: string,
  ): void => {
    if (terminalAddBusy !== null) return;
    setTerminalAddBusy(busyKey);
    const ownerDocument = anchor?.ownerDocument;
    const pickedRow = ownerDocument?.activeElement ?? null;
    void (async (): Promise<void> => {
      try {
        const added = await createTerminalPanel(
          worktreeKey,
          groupId,
          terminalProfileId,
          title,
          command,
          ownerDocument,
        );
        if (!added) return;
        // The new terminal may already hold the caret: its pane redeems the
        // spawn's focus request as soon as it mounts. Hand focus back to `+`
        // only while it is still on the picked row, which is about to unmount.
        const active = ownerDocument?.activeElement ?? null;
        if (active === pickedRow || active === ownerDocument?.body) {
          anchor?.querySelector<HTMLButtonElement>('button')?.focus();
        }
        onClose();
      } finally {
        setTerminalAddBusy(null);
      }
    })();
  };

  const terminalPresetIcon = (preset: TerminalPreset): JSX.Element => {
    if (preset.icon?.kind === 'image') {
      const dataUrl = resolveTerminalPresetImageDataUrl(
        preset.icon,
        terminalPresetColorMode,
      );
      if (!dataUrl) return <TerminalIcon />;
      return (
        <img src={dataUrl} alt="" className="h-4 w-4 rounded object-contain" />
      );
    }
    if (preset.icon?.kind === 'character') {
      return <span className="text-s leading-none">{preset.icon.value}</span>;
    }
    return <TerminalIcon />;
  };

  const handleAddBrowser = (): void => {
    if (browserAddBusy || isAuxPanelLayoutKey(worktreeKey)) {
      return;
    }
    setBrowserAddBusy(true);
    void (async (): Promise<void> => {
      try {
        const added = await createBrowserPanel(worktreeKey, groupId);
        if (!added) return;
        anchor?.querySelector<HTMLButtonElement>('button')?.focus();
        onClose();
      } finally {
        setBrowserAddBusy(false);
      }
    })();
  };

  const cursorEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key),
  );
  const copilotEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key),
  );
  const ledgerEnabled = useFeatureFlagsStore((state) =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key),
  );
  const access = useWorkspaceAccess();
  // Early access: Activity sections open from the Activity card, as Side
  // Panel tabs, so the menu leaves them (and the whole Activity panel) out.
  // A shared-container viewer has no card and keeps them.
  const activityFromCard =
    earlyAccess && !isSharedContainerViewerLayout(worktreeKey);

  // Snapshot the addable catalog when the menu opens (it derives from live
  // chat + layout store state; the menu is ephemeral, so open-time is enough).
  const entries = useMemo(() => {
    const catalog = listAddablePanels(
      worktreeKey,
      cursorEnabled,
      copilotEnabled,
      ledgerEnabled,
    );
    return catalog.filter(
      (entry) =>
        !excludeKinds?.includes(entry.kind) &&
        !(activityFromCard && entry.kind === 'activity-section') &&
        (entry.kind !== 'activity-card' ||
          isActivitySectionAllowedForAccess(
            entry.instance?.sectionId ?? '',
            access,
          )),
    );
  }, [
    worktreeKey,
    excludeKinds,
    cursorEnabled,
    copilotEnabled,
    ledgerEnabled,
    access,
    activityFromCard,
  ]);
  // Primary (singletons + chat/file) lead; the labeled "Usage",
  // "Workflows", and "Activity" groups each follow their own divider.
  const primaryEntries = entries.filter(
    (entry) =>
      (entry.kind !== 'activity-card' ||
        entry.instance?.sectionId === 'memory') &&
      entry.group === undefined,
  );
  const usageEntries = entries.filter((entry) => entry.group === 'usage');
  const automationsEntries = entries.filter(
    (entry) => entry.group === 'automations',
  );
  // One row per chat without an open breakdown.
  const sessionBreakdownEntries = entries.filter(
    (entry) => entry.group === 'session-breakdown',
  );
  // Memory leads the primary entries and the plans list card has its own
  // Plans entry, so neither is repeated under Activity.
  const sectionEntries = entries.filter(
    (entry) =>
      !activityFromCard &&
      entry.kind === 'activity-card' &&
      entry.instance?.sectionId !== 'memory' &&
      entry.instance?.sectionId !== 'plans',
  );
  // The Plans entry is an open-or-reveal catalog read live from the plan
  // and layout stores (not the open-time snapshot above), so the list card
  // and open plans stay listed.
  const plansSection = usePlansAddMenuSection({
    worktreeKey,
    groupId,
    excludeKinds,
    onSelect,
    onClose,
  });

  const toViewEntry = (entry: AddablePanelEntry): PanelAddTabMenuViewEntry => {
    if (entry.kind === 'browser') {
      return {
        testId: entryTestId(entry),
        label: entry.label,
        icon: browserAddBusy ? <LoadingSpinner /> : entry.icon,
        onActivate: handleAddBrowser,
        disabled: browserAddBusy,
        ariaBusy: browserAddBusy,
        keepOpenOnActivate: true,
      };
    }
    // Chat and file rows show their own titles; panel and section names
    // show in sentence case under early access. The added tab still stores
    // the registry name (see `earlyAccessTitles`).
    const label =
      entry.kind === 'chat' ||
      entry.kind === 'file-diff' ||
      entry.kind === 'session-breakdown'
        ? entry.label
        : earlyAccessTitle(entry.label);
    if (entry.kind === 'subagents') {
      return {
        testId: entryTestId(entry),
        label,
        icon: entry.icon,
        keepOpenOnActivate: true,
        onActivate: (): void => {
          const scope = subagentPanelScopeForLayoutKey(worktreeKey);
          if (scope === null) return;
          void openSubagentsPanel(scope, {
            intent: { groupId, layoutKey: worktreeKey },
          });
          onClose();
        },
      };
    }
    return {
      testId: entryTestId(entry),
      label,
      icon: entry.icon,
      onActivate: (): void => {
        onSelect(
          entry.kind,
          entry.instance !== undefined
            ? { instance: entry.instance, title: entry.label }
            : undefined,
        );
      },
    };
  };

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />
      {anchor !== null ? (
        <PanelAddTabMenuView
          anchor={anchor}
          groupId={groupId}
          entries={[
            ...(!excludeKinds?.includes('chat')
              ? [
                  {
                    testId: 'panel-add-menu-item-new-chat',
                    label: `New ${CHAT_UNIT_LABEL}`,
                    icon: <ChatIcon />,
                    onActivate: handleNewChat,
                  },
                ]
              : []),
            ...(!excludeKinds?.includes('file-diff')
              ? [
                  {
                    testId: 'panel-add-menu-item-new-file',
                    label: 'File',
                    icon: <FilesIcon />,
                    onActivate: handleNewFileTab,
                  },
                ]
              : []),
            ...primaryEntries.map(toViewEntry),
          ]}
          sections={[
            ...(!excludeKinds?.includes('terminal')
              ? [
                  {
                    id: 'terminal',
                    label: 'Terminal',
                    presentation: 'submenu' as const,
                    icon: <TerminalIcon />,
                    entries: [],
                    subsections: [
                      {
                        id: 'shells',
                        label: 'Shells',
                        entries: terminalShellRows.map(
                          ({ profile, label }) => ({
                            testId: profile.isDefault
                              ? 'panel-add-menu-item-terminal'
                              : `panel-add-menu-item-terminal-${profile.id}`,
                            label,
                            accessory: profile.isDefault ? (
                              <TerminalDefaultShellBadge testId="panel-add-menu-item-terminal-default-badge" />
                            ) : undefined,
                            tooltip: profile.isDefault
                              ? TERMINAL_DEFAULT_SHELL_TOOLTIP
                              : undefined,
                            icon:
                              terminalAddBusy === `shell:${profile.id}` ? (
                                <LoadingSpinner />
                              ) : (
                                <TerminalIcon />
                              ),
                            onActivate: (): void => {
                              handleAddTerminal(
                                `shell:${profile.id}`,
                                profile.id,
                                label,
                              );
                            },
                            disabled: terminalAddBusy !== null,
                            ariaBusy: terminalAddBusy === `shell:${profile.id}`,
                            keepOpenOnActivate: true,
                          }),
                        ),
                      },
                      {
                        id: 'presets',
                        label: 'Presets',
                        entries: enabledTerminalPresets.map((preset) => ({
                          key: preset.id,
                          testId: 'panel-add-menu-item-terminal-preset',
                          label: preset.name,
                          icon:
                            terminalAddBusy === `preset:${preset.id}` ? (
                              <LoadingSpinner />
                            ) : (
                              terminalPresetIcon(preset)
                            ),
                          onActivate: (): void => {
                            handleAddTerminal(
                              `preset:${preset.id}`,
                              preset.terminalProfileId,
                              preset.name,
                              preset.command,
                            );
                          },
                          disabled: terminalAddBusy !== null,
                          ariaBusy: terminalAddBusy === `preset:${preset.id}`,
                          keepOpenOnActivate: true,
                        })),
                      },
                    ],
                    footerEntries: [
                      {
                        testId: 'panel-add-menu-terminal-settings',
                        label: 'Settings',
                        icon: <SettingsIcon />,
                        onActivate: (): void => {
                          onClose();
                          useNavigationStore
                            .getState()
                            .openSettings('terminal');
                        },
                      },
                    ],
                  },
                ]
              : []),
            ...(plansSection !== null ? [plansSection] : []),
            {
              id: 'usage',
              label: 'Usage',
              presentation: 'submenu' as const,
              icon: <DataUsageIcon />,
              entries: usageEntries.map(toViewEntry),
            },
            {
              id: 'automations',
              label: 'Workflows',
              presentation: 'submenu' as const,
              icon: <WorkflowsIcon size="xl" />,
              entries: automationsEntries.map(toViewEntry),
            },
            ...(sessionBreakdownEntries.length > 0
              ? [
                  {
                    id: 'session-breakdown',
                    label: 'Session breakdown',
                    presentation: 'submenu' as const,
                    icon: <BarChart4BarsIcon />,
                    entries: sessionBreakdownEntries.map(toViewEntry),
                  },
                ]
              : []),
            // Early access leaves no Activity entries, so no heading either.
            ...(!activityFromCard || sectionEntries.length > 0
              ? [
                  {
                    id: 'activity',
                    label: 'Activity',
                    entries: sectionEntries.map(toViewEntry),
                  },
                ]
              : []),
          ]}
          onClose={onClose}
        />
      ) : null}
    </>
  );
}
