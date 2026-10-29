import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { useMarketplaceList } from '@/hooks/useMarketplaceList';
import { pluginNeedsInstall } from '@/lib/pluginInstallStatus';
import { useSafeRemoteImageUrl } from '@/lib/remote-image';
import {
  getUnsupportedReason,
  type PluginSelectorProviderScope,
} from './pluginSelectorScope';
import type { ComposerMenuController } from '@/hooks/useComposerMenu';
import type { FileMentionOption } from '@canopy/ui-rich/types';
import { searchSlashCommands } from '@canopy/ui-rich/plugins';
import type { ComposerCommand } from '@/lib/composerCommands';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ComposerActionList,
  type ComposerActionRow,
  FloatingMenu,
  Tooltip,
} from '@canopy/ui-shared';
import {
  CommandIcon,
  PluginsIcon,
  SkillIcon,
  FileIcon,
  LinearIcon,
  PlusLargeIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useLinearAvailability } from '@/hooks/useLinearStatus';
import { ComposerIconButton } from '@/components/shared/ComposerIconButton';
import { useSettingsLocationLabel } from '@/lib/navigation/settings-destinations';

export interface ComposerPlusMenuItem {
  id: string;
  label: string;
  description?: string;
  /**
   * The section the row sits in: `settings` (Current settings) for toggles
   * like Plan mode, `view` (View) for the chat's interface modes, otherwise
   * Add.
   */
  group?: 'settings' | 'view';
  value?: string;
  opensMenu?: boolean;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  selected?: boolean;
  ariaChecked?: boolean;
  /** One of a set of exclusive choices: the chosen row shows a check. */
  checked?: boolean;
  dataTestId?: string;
  disabledTooltip?: {
    title: string;
    description: string;
  };
}

export interface ComposerPlusMenuProps {
  controller?: ComposerMenuController;
  /**
   * The composer box the menu attaches to when there is no `controller`: the
   * menu spans the box's width and opens against its edge.
   */
  composerAnchorRef?: RefObject<HTMLElement | null>;
  /** Space between the composer box and the menu. */
  gap?: number;
  placement?: 'top-left' | 'bottom-left';
  allowFlip?: boolean;
  searchFiles?: (query: string) => FileMentionOption[];
  onSelectFile?: (file: FileMentionOption) => void;
  /** Opens the native file picker / attaches a file. */
  onPickAttachment?: () => void;
  /** Opens the Linear ticket picker. Only invoked when Linear is available. */
  onPickLinear?: () => void;
  /** Disables the trigger button entirely (e.g. terminal mode). */
  disabled?: boolean;
  /** Prefix for every `data-testid` this component renders. */
  dataTestIdPrefix: string;
  onOpenChange?: (open: boolean) => void;
  /** Optional composer-specific actions rendered after attachment actions. */
  additionalItems?: ComposerPlusMenuItem[];
  commands?: ComposerCommand[];
  /** Home lets a new task browse capabilities from both + and /. */
  includeCommandsInAddMenu?: boolean;
  providerScope?: PluginSelectorProviderScope;
  pluginSelections?: ChatTabPluginSelections;
  /**
   * A whole-plugin row was picked. `enabled` reports whether the plugin was
   * already selected for this chat so the host can skip re-enabling it; the
   * host inserts the `@` mention pill (`label`) either way.
   */
  onSelectPlugin?: (
    ref: ChatTabPluginSelections['pluginRefs'][number],
    meta: { label: string; enabled: boolean },
  ) => void;
  onSelectCommand?: (command: ComposerCommand) => void;
  isRefreshing?: boolean;
  /**
   * The chat and Home composers' 32px capsule: a flat subtle fill with a
   * one-device-pixel inset rim, the same in every composer.
   */
  capsuleTrigger?: boolean;
  /** Highlights the trigger when an active action has collapsed into the menu. */
  active?: boolean;
  /** Accessible description appended while `active`. */
  activeLabel?: string;
  /**
   * Receives the trigger element. Consumers that open their own floating
   * surface from a menu row need it as a `returnFocusRef`, so dismissing that
   * surface restores focus to the `+` rather than dropping it on `<body>`.
   */
  triggerRef?: RefObject<HTMLButtonElement | null>;
}

/** Hover tooltip and accessible name for the `+` trigger. */
const COMPOSER_PLUS_MENU_LABEL = 'More actions';
/** What the menu is for, shown on hover beside its @ shortcut. */
const COMPOSER_PLUS_MENU_TOOLTIP = 'Add files and more';

/**
 * Shared `+` composer control: an icon or capsule trigger that opens an
 * anchored dropdown with attachment actions and optional composer-specific
 * actions. Used by both the Home composer and `ChatInput` so the attach-menu
 * behavior (including Linear availability gating) lives in one place instead
 * of being duplicated per surface.
 *
 * Owns Linear availability internally — loads the token and validates it via
 * `useLinearStatus`, exactly like the old `HomeLinearAttach` did at mount —
 * so consumers don't need to duplicate that token-load dance just to decide
 * whether to render a Linear option. The row's PRESENCE follows the stored
 * token rather than a validated status, and its enabled state follows
 * validation: connecting Linear is an account-level integration that lives in
 * Settings → Account (CAN-2709), so the menu never offers a connect
 * affordance — but it must not make an existing connection disappear either.
 */
/** Skip Linear token reads entirely for configuration composers without attachments. */
export function ComposerPlusMenu(props: ComposerPlusMenuProps): JSX.Element {
  return props.onPickLinear ? (
    <ComposerPlusMenuWithLinear {...props} />
  ) : (
    <ComposerPlusMenuContent {...props} linearAvailability={null} />
  );
}

function ComposerPlusMenuWithLinear(props: ComposerPlusMenuProps): JSX.Element {
  const linearAvailability = useLinearAvailability();
  return (
    <ComposerPlusMenuContent
      {...props}
      linearAvailability={linearAvailability}
    />
  );
}

function ComposerPlusMenuContent({
  controller,
  composerAnchorRef,
  gap,
  placement = 'top-left',
  allowFlip = true,
  searchFiles,
  onSelectFile,
  onPickAttachment,
  onPickLinear,
  disabled = false,
  dataTestIdPrefix,
  onOpenChange,
  additionalItems = [],
  commands = [],
  includeCommandsInAddMenu = false,
  providerScope = 'mixed',
  pluginSelections,
  onSelectPlugin,
  onSelectCommand,
  isRefreshing = false,
  capsuleTrigger = false,
  active = false,
  activeLabel = 'Active composer action',
  triggerRef,
  linearAvailability,
}: ComposerPlusMenuProps & {
  linearAvailability: ReturnType<typeof useLinearAvailability> | null;
}): JSX.Element {
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = controller?.open ?? localOpen;
  const variant = controller?.variant ?? 'add';
  const isAddMenu = variant === 'add';
  const isToolbarMenu = !controller || controller.origin === 'toolbar';
  const setIsOpen = controller?.onOpenChange ?? setLocalOpen;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const [localQuery, setLocalQuery] = useState('');
  const query = controller?.query ?? localQuery;
  const setQuery = controller?.setQuery ?? setLocalQuery;
  // The catalog is only needed once the Add menu is open; the composer is
  // mounted on every chat and Home surface, so keep the load off startup.
  const { cache: pluginCatalog } = useMarketplaceList({
    enabled: isOpen && isAddMenu && !!onSelectPlugin,
  });

  useEffect(() => {
    if (!isOpen) {
      if (!controller) setLocalQuery('');
    }
  }, [isOpen, controller]);
  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null): void => {
      buttonRef.current = node;
      if (triggerRef) triggerRef.current = node;
    },
    [triggerRef],
  );

  // CAN-2709: connecting Linear is account-level and lives in Account
  // settings. Only the per-message action — attaching a ticket — belongs
  // beside the input, and only once a connection exists. "Exists" means a
  // stored token (`tokenPresent`), not a validated one — see the row below.
  const linearAvailable = linearAvailability?.available ?? false;
  const linearTokenPresent = linearAvailability?.tokenPresent ?? false;
  const linearStatus = linearAvailability?.status ?? null;
  // Only read inside the `linearTokenPresent` branch, and a non-empty stored
  // token implies the load finished — so `tokenLoaded` cannot discriminate here.
  const linearStatusPending = linearStatus === null;
  // The App Advisor window renders this same composer but has no Account tab
  // in its own settings modal (Defaults / Instructions / Advanced only), so
  // "Settings → Account" is not a reachable instruction there. The removed
  // `Connect Linear` row used to carry this same surface check.
  const linearSettingsReachableHere =
    typeof document === 'undefined' ||
    document.body.dataset.rendererSurface !== 'app-advisor';
  const linearSettingsLocation = useSettingsLocationLabel('integrations');
  // CAN-2706: one purpose-shaped name for both the tooltip and the accessible
  // name. Naming the contents ("Attach a file or Linear ticket") goes stale
  // every time the menu changes, and CAN-2710 is actively reconsidering what
  // belongs in here.
  const triggerAriaLabel = active
    ? `${COMPOSER_PLUS_MENU_LABEL}, ${activeLabel}`
    : COMPOSER_PLUS_MENU_LABEL;

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  function handlePickAttachment(): void {
    controller?.prepareAction();
    setIsOpen(false);
    onPickAttachment?.();
  }

  function handlePickLinear(): void {
    if (!linearAvailable) return;
    controller?.prepareAction();
    setIsOpen(false);
    onPickLinear?.();
  }

  function handleAdditionalItem(item: ComposerPlusMenuItem): void {
    if (item.disabled) return;
    controller?.prepareAction();
    setIsOpen(false);
    item.onSelect();
  }

  const descriptions: Record<string, string> = {
    plugins: 'Choose capabilities for this chat',
    commands: 'Browse skills and commands',
    'plan-mode': 'Plan before making changes',
    schedule: 'Send this message later',
  };
  const actionRows: ComposerActionRow[] = [
    ...(onPickAttachment
      ? [
          {
            id: 'attachment',
            label: 'Files and folders',
            description: 'Add an attachment',
            icon: <FileIcon />,
            group: 'Add',
            popupRole: 'dialog' as const,
            onSelect: handlePickAttachment,
            dataTestId: `${dataTestIdPrefix}-plus-attachment`,
          },
        ]
      : []),
    ...(onPickLinear && (linearTokenPresent || linearAvailable)
      ? [
          {
            id: 'linear',
            label: 'Linear',
            description: linearAvailable
              ? 'Attach an issue'
              : linearStatusPending
                ? 'Checking your Linear connection'
                : linearSettingsReachableHere
                  ? `Check your Linear API key. Update it in ${linearSettingsLocation}.`
                  : 'Check your Linear API key. Update it in Account settings in the main window.',
            icon: <LinearIcon />,
            group: 'Add',
            disabled: !linearAvailable,
            popupRole: 'dialog' as const,
            onSelect: handlePickLinear,
            dataTestId: `${dataTestIdPrefix}-plus-linear`,
          },
        ]
      : []),
    ...additionalItems
      .filter((item) => item.id !== 'commands')
      .map((item) => ({
        ...item,
        popupRole: item.opensMenu ? ('menu' as const) : undefined,
        group:
          item.group === 'settings'
            ? 'Current settings'
            : item.group === 'view'
              ? 'View'
              : 'Add',
        description: item.disabled
          ? (item.disabledTooltip?.description ??
            item.description ??
            descriptions[item.id])
          : (item.description ?? descriptions[item.id]),
        onSelect: () => handleAdditionalItem(item),
      })),
  ];
  const planToggle = additionalItems.find((item) => item.id === 'plan-mode');
  const visibleActions = !isAddMenu
    ? []
    : actionRows.filter((row) =>
        `${row.label} ${row.description ?? ''} ${row.value ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase().trim()),
      );
  const composerCommandNames = useMemo(
    () =>
      new Set(
        commands
          .filter((command) => command.composerAction)
          .map((command) => command.name),
      ),
    [commands],
  );
  // Home also exposes capability members from +. Composer actions remain in
  // the Add menu's existing action rows rather than appearing a second time.
  const catalog = useMemo(
    () =>
      (isOpen ? commands : []).filter((command) => {
        if (command.composerAction === 'plan' && !planToggle) return false;
        if (!isAddMenu)
          return (
            !command.browseNamespace &&
            (!!command.composerAction ||
              !composerCommandNames.has(command.name))
          );
        return (
          includeCommandsInAddMenu &&
          isToolbarMenu &&
          !command.browseNamespace &&
          !command.composerAction &&
          !composerCommandNames.has(command.name)
        );
      }),
    [
      isOpen,
      commands,
      isAddMenu,
      includeCommandsInAddMenu,
      isToolbarMenu,
      composerCommandNames,
      planToggle,
    ],
  );
  const rankedCommands = useMemo(
    () => searchSlashCommands(catalog, query),
    [catalog, query],
  );
  const commandRows: ComposerActionRow[] = rankedCommands.map(
    (command, index) => {
      const toggle = command.composerAction === 'plan' ? planToggle : undefined;
      return {
        id: `command:${command.name}:${index}`,
        label: command.displayName ?? command.name,
        description:
          toggle?.description ?? command.disabledReason ?? command.description,
        ariaChecked: toggle?.ariaChecked,
        value: toggle?.value,
        icon:
          toggle?.icon ??
          (command.inventoryEntry?.kind.includes('skill') ? (
            <SkillIcon />
          ) : (
            <CommandIcon />
          )),
        group: command.composerAction
          ? 'Commands'
          : command.section === 'available'
            ? 'Available to enable'
            : 'Skills and commands',
        disabled: toggle?.disabled || !!command.disabledReason,
        dataTestId: `${dataTestIdPrefix}-capability-${command.name}`,
        completion: !command.composerAction,
        onSelect: (): void => {
          if (toggle) {
            handleAdditionalItem(toggle);
            return;
          }
          if (
            command.composerAction === 'help' ||
            command.composerAction === 'commands'
          ) {
            setQuery('');
          } else {
            controller?.beginSelection();
            onSelectCommand?.(command);
            setIsOpen(false);
          }
        },
      };
    },
  );
  const files = useMemo(
    () => (isOpen && isAddMenu ? (searchFiles?.(query) ?? []) : []),
    [isOpen, isAddMenu, searchFiles, query],
  );
  const fileRows: ComposerActionRow[] = files.map((file) => ({
    id: `file:${file.absolutePath}`,
    label: file.filename,
    description: file.relativePath,
    group:
      file.kind === 'note'
        ? 'Notes'
        : file.kind === 'prompt'
          ? 'Prompts'
          : file.kind === 'attachment'
            ? 'Attachments'
            : 'Files',
    icon: <FileIcon />,
    dataTestId: `${dataTestIdPrefix}-file-result`,
    completion: true,
    onSelect: (): void => {
      onSelectFile?.(file);
      setIsOpen(false);
    },
  }));
  const pluginRows: ComposerActionRow[] =
    isOpen && isAddMenu && onSelectPlugin
      ? (pluginCatalog?.marketplaces ?? []).flatMap((marketplace) =>
          marketplace.plugins
            .filter(
              (plugin) =>
                // The composer menu is a quick picker for what THIS chat can
                // use right now: plugins that still need installing and
                // plugins the selected model cannot load are omitted outright
                // rather than listed disabled (the full Plugins picker keeps
                // every row with its reason and install affordance).
                !pluginNeedsInstall(plugin) &&
                getUnsupportedReason(plugin.providerSupport, providerScope) ===
                  null &&
                `${plugin.displayName ?? plugin.name} ${plugin.description ?? ''}`
                  .toLowerCase()
                  .includes(query.toLowerCase().trim()),
            )
            .map((plugin) => {
              const enabled = pluginSelections?.pluginRefs.some(
                (ref) =>
                  ref.marketplaceId === marketplace.id &&
                  ref.pluginName === plugin.name,
              );
              const label = plugin.displayName ?? plugin.name;
              return {
                id: `plugin:${marketplace.id}:${plugin.name}`,
                label,
                description:
                  plugin.description ?? 'Use this plugin for this chat',
                icon: <ComposerPluginLogo logoUrl={plugin.logoUrl} />,
                group: 'Plugins',
                ariaChecked: !!enabled,
                value: enabled ? 'Enabled' : undefined,
                dataTestId: `${dataTestIdPrefix}-plugin-${marketplace.id}-${plugin.name}`,
                completion: true,
                onSelect: (): void => {
                  // No `prepareAction()` here: like file rows, the host's
                  // `insertPlugin` consumes the trigger when it drops the pill.
                  onSelectPlugin(
                    {
                      marketplaceId: marketplace.id,
                      pluginName: plugin.name,
                    },
                    { label, enabled: !!enabled },
                  );
                  setIsOpen(false);
                },
              };
            }),
        )
      : [];
  const rows = [...visibleActions, ...pluginRows, ...commandRows, ...fileRows];

  const handleTriggerKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (controller && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  return (
    <>
      <Tooltip
        // Typing @ in the draft opens this same menu, so the tooltip teaches
        // the shortcut beside what the button does.
        label={
          controller ? COMPOSER_PLUS_MENU_TOOLTIP : COMPOSER_PLUS_MENU_LABEL
        }
        {...(controller ? { shortcut: '@' } : {})}
        suppressed={isOpen}
      >
        {capsuleTrigger ? (
          // The capsule trigger (the chat and Home composers): send-button
          // geometry (32px circle, 16px glyph) on a flat subtle fill that
          // steps up to muted on hover, written as one explicit class list
          // so no variant background can override it.
          <button
            ref={setTriggerRef}
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            onKeyDown={handleTriggerKeyDown}
            disabled={disabled}
            className={`focus-ring inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition enabled:active:scale-97 disabled:cursor-not-allowed disabled:fg-tertiary disabled:opacity-100 ${
              active
                ? 'bg-warning-subtle fg-warning enabled:hover:bg-warning-subtle'
                : // A one-device-pixel inset rim in the quiet line role
                  // keeps the + defined against the composer's surface.
                  'bg-subtle fg-primary ring-[length:var(--border-hairline)] ring-inset ring-line-tertiary enabled:hover:bg-muted'
            }`}
            data-testid={`${dataTestIdPrefix}-plus-button`}
            data-active={active ? 'true' : undefined}
            aria-label={triggerAriaLabel}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-controls={isOpen ? menuId : undefined}
          >
            {/* The large plus: its ink matches the send arrow, the microphone
              and stop beside it (the medium plus read a size smaller). */}
            <PlusLargeIcon size={16} />
          </button>
        ) : (
          <ComposerIconButton
            ref={setTriggerRef}
            onClick={() => setIsOpen(!isOpen)}
            onKeyDown={handleTriggerKeyDown}
            disabled={disabled}
            tone={active ? 'warning' : 'default'}
            active={active}
            data-testid={`${dataTestIdPrefix}-plus-button`}
            data-active={active ? 'true' : undefined}
            aria-label={triggerAriaLabel}
            aria-haspopup="dialog"
            aria-expanded={isOpen}
            aria-controls={isOpen ? menuId : undefined}
          >
            <PlusLargeIcon width={16} height={16} />
          </ComposerIconButton>
        )}
      </Tooltip>

      <FloatingMenu
        id={menuId}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={controller?.anchorRef ?? composerAnchorRef ?? buttonRef}
        {...(gap !== undefined ? { gap } : {})}
        placement={placement}
        allowFlip={allowFlip}
        interaction="manual"
        outsidePressBoundaryRef={controller?.editorRef}
        returnFocusRef={controller?.editorRef ?? buttonRef}
        role="dialog"
        aria-label="Composer actions"
        data-testid={`${dataTestIdPrefix}-plus-menu`}
        data-menu-variant={variant}
        data-chat-cancel-shortcut-ignore
        motion="none"
        className={`flex flex-col overflow-hidden ${
          controller || composerAnchorRef
            ? 'w-[var(--floating-menu-anchor-width)]'
            : 'w-[min(42rem,calc(100vw-2rem))]'
        }`}
        // This composer-attached surface matches the composer’s 20px corners.
        style={{ borderRadius: 'var(--radius-2xl)', paddingBlock: 0 }}
        heightLimit={280}
      >
        <ComposerActionList
          rows={rows}
          menuRef={controller?.menuRef}
          activeId={controller?.activeId}
          onActiveIdChange={controller?.setActiveId}
          onHoveredIdChange={controller?.setHoveredId}
          loading={isRefreshing}
          dataTestIdPrefix={dataTestIdPrefix}
          // Session replay records each group's rows as a placeholder: the
          // menu lists the whole skill/plugin/command catalog unwindowed, so
          // opening it would otherwise serialize thousands of elements.
          blockRowsFromReplay
        />
      </FloatingMenu>
    </>
  );
}

/** Keep remote images behind the existing safe image resolver. */
function ComposerPluginLogo({ logoUrl }: { logoUrl?: string }): JSX.Element {
  const src = useSafeRemoteImageUrl(logoUrl);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return src && src !== failedSrc ? (
    <img
      src={src}
      alt=""
      width={16}
      height={16}
      className="shrink-0 object-contain"
      onError={() => setFailedSrc(src)}
    />
  ) : (
    <PluginsIcon />
  );
}
