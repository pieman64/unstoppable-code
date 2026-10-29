'use client';

import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import type {
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';
import { isSameWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  ActionMenuRowStyle,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  FloatingMenu,
  SidebarAiCreditsMenuItem,
} from '@canopy/ui-shared/components';
import {
  BuildingIcon,
  CheckIcon,
  ChevronDownMediumIcon,
  PersonIcon,
  SettingsIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { creditsBillingTargetPath } from '@canopy/protocol/billing';
import {
  SidebarCreateOrganizationMenuItem,
  SidebarFeedMenuItem,
  SidebarInviteTeamMenuItem,
  SidebarStatisticsMenuItem,
} from './AccountMenuActivityItem';
import {
  resolveSidebarContextActions,
  type SidebarContextActions,
} from './sidebar-context-actions';

/**
 * The selected context's actions under the switcher's context list
 * (CAN-4057): Feed, Statistics, Invite your team, the organization's AI
 * Credits, and Organization settings, after Create an organization at the
 * end of the context list (CAN-4554). Which rows show is decided by
 * {@link resolveSidebarContextActions}, never by which callbacks the host
 * passes; the callbacks only say how the host opens each destination.
 */
export interface SidebarContextOrgScopedActions {
  /**
   * Whether account identity is authenticated and non-guest. Defaults to true
   * for hosts mounted only for authenticated users; false hides every action
   * even if an independently loaded membership snapshot has not cleared yet.
   */
  readonly authenticated?: boolean;
  /**
   * External ID of the viewer's personal organization; `null` while loading,
   * for guests, and before it is provisioned (Personal then has only Create
   * an organization).
   */
  readonly personalOrganizationId: string | null;
  /** Free app access: an OWNER gets the organization's AI Credits row. */
  readonly freeAccess: boolean;
  /** Opens a hosted page path; the menu has already closed. */
  readonly onOpenPath: (path: string) => void;
  /** Opens the Create a team flow from Personal; omitted ⇒ no row. */
  readonly onCreateTeam?: () => void;
  /** Opens the invite dialog for an organization; omitted ⇒ no row. */
  readonly onInviteToTeam?: (
    organization: WorkspaceContextOrganization,
  ) => void;
  /**
   * The organization pool's balance, read by the host. The row asks for a
   * fresh read each time it mounts (the menu mounts rows only while open) and
   * shows the number only when it belongs to the organization the row opens.
   */
  readonly credits?: {
    readonly organizationId: string;
    readonly balanceCredits: number | null;
    readonly refresh: () => void;
  };
}

/**
 * The Personal/organization switcher at the top of the sidebar (CAN-2953,
 * CAN-4053, CAN-4057), on both the web portal and the desktop sidebar. Dumb by
 * design: the host supplies the current context and the organizations the
 * account belongs to, and receives the selection; it never grants access,
 * because selecting a context is a navigation fact only.
 *
 * An account with no organizations still gets the row, on Personal with
 * Personal's actions; whether to mount it at all is
 * `sidebarContextSwitcherAvailable`.
 */
export interface SidebarContextRowProps {
  readonly context: WorkspaceContext;
  readonly organizations: readonly WorkspaceContextOrganization[];
  readonly onSelect: (context: WorkspaceContext) => void;
  /** The selected context's actions under the context list (CAN-4057). */
  readonly orgScoped: SidebarContextOrgScopedActions;
  /** Told each time the menu opens or closes. */
  readonly onOpenChange?: (open: boolean) => void;
  /** Disables the trigger while a switch is in flight. */
  readonly disabled?: boolean;
  /**
   * `footer` (default) is a plain row, menu opening upward. `top` sits above
   * New task with no surface at rest, so it never reads as a second selected
   * row; hover, keyboard focus and the open menu wash it with `bg-subtle`. It
   * keeps the rows' 32px height, uses the 16px text style, and opens downward.
   */
  readonly placement?: 'footer' | 'top';
  /**
   * Contexts with work left running, unread, or interrupted (CAN-2959),
   * keyed `'personal'` or by organization id. Each other context in the set
   * gets the unread-blue dot on its menu row, and the trigger carries one dot
   * so the user knows to open the menu. The current context never shows a
   * dot: its work is already on screen.
   */
  readonly contextsWithUpdates?: ReadonlySet<string>;
  /**
   * Re-enter the desktop sidebar's instant-feedback scope by name, as the
   * account row's menu does: the menu portals out of the sidebar's subtree.
   */
  readonly menuInstantInteractions?: boolean;
  readonly testIds?: {
    readonly row?: string;
    readonly menu?: string;
    readonly optionPersonal?: string;
    /** Prefix for organization options; the organization id is appended. */
    readonly optionOrganizationPrefix?: string;
    /** The organization AI Credits row; `-balance` is appended for its pill. */
    readonly credits?: string;
    readonly organizationSettings?: string;
    /** The trigger's other-context updates dot. */
    readonly attentionDot?: string;
    /** Prefix for a menu row's updates dot; `personal` or the id is appended. */
    readonly activityPrefix?: string;
  };
}

interface NamedOrganization {
  readonly id: string;
  readonly name: string;
}

interface OrganizationOption<T extends NamedOrganization> {
  readonly organization: T;
  /** Secondary text shown only when another organization shares the name. */
  readonly secondary: string | null;
}

/** Trailing id characters used to tell two same-named organizations apart. */
const IDENTITY_SUFFIX_LENGTH = 6;

function identitySuffix(id: string): string {
  return id.replace(/-/g, '').slice(-IDENTITY_SUFFIX_LENGTH);
}

/**
 * Organizations sorted by name, with a secondary identity only where two
 * display names collide. Exported for tests and for hosts that render the
 * same list elsewhere (account menu, command palette).
 */
export function buildOrganizationOptions<T extends NamedOrganization>(
  organizations: readonly T[],
): OrganizationOption<T>[] {
  const counts = new Map<string, number>();
  for (const organization of organizations) {
    const key = organization.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...organizations]
    .sort(
      (a, b) =>
        a.name
          .trim()
          .toLowerCase()
          .localeCompare(b.name.trim().toLowerCase()) ||
        a.id.localeCompare(b.id),
    )
    .map((organization) => ({
      organization,
      secondary:
        (counts.get(organization.name.trim().toLowerCase()) ?? 0) > 1
          ? identitySuffix(organization.id)
          : null,
    }));
}

function UpdatesDot({ testId }: { readonly testId: string }): JSX.Element {
  return (
    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
      <span
        aria-hidden="true"
        data-testid={testId}
        className={`h-1.5 w-1.5 rounded-full ${OPERATIONAL_STATUS_COLORS.unread.background}`}
      />
    </span>
  );
}

/**
 * A context's 16px glyph: the person icon for Personal, the organization's
 * logo, or the building icon when it has none (or its logo fails to load).
 */
export function SidebarContextGlyph({
  kind,
  logoUrl,
}: {
  readonly kind: WorkspaceContext['kind'];
  readonly logoUrl?: string | null;
}): JSX.Element {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  if (kind === 'personal') {
    return (
      <PersonIcon
        size={16}
        aria-hidden="true"
        data-testid="sidebar-context-glyph-person"
      />
    );
  }
  if (logoUrl && brokenSrc !== logoUrl) {
    return (
      <img
        src={logoUrl}
        width={16}
        height={16}
        className="rounded-sm object-cover shrink-0"
        alt=""
        aria-hidden="true"
        data-testid="sidebar-context-glyph-logo"
        onError={() => setBrokenSrc(logoUrl)}
      />
    );
  }
  return (
    <BuildingIcon
      size={16}
      aria-hidden="true"
      data-testid="sidebar-context-glyph-building"
    />
  );
}

export function SidebarContextRow({
  context,
  organizations,
  onSelect,
  orgScoped,
  onOpenChange,
  disabled = false,
  placement = 'footer',
  contextsWithUpdates,
  menuInstantInteractions = false,
  testIds,
}: SidebarContextRowProps): JSX.Element {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (next !== open) onOpenChange?.(next);
  };
  const rowRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const options = useMemo(
    () => buildOrganizationOptions(organizations),
    [organizations],
  );

  const current =
    context.kind === 'organization'
      ? (organizations.find(
          (organization) => organization.id === context.organizationId,
        ) ?? null)
      : null;
  const currentLabel =
    context.kind === 'personal'
      ? 'Personal'
      : (current?.name ?? 'Organization');
  const currentKey =
    context.kind === 'personal' ? 'personal' : context.organizationId;
  const hasUpdates = (key: string): boolean =>
    key !== currentKey && (contextsWithUpdates?.has(key) ?? false);
  // Personal first, then organizations in menu order, as the menu lists them.
  const updatedContextNames = [
    ...(hasUpdates('personal') ? ['Personal'] : []),
    ...options
      .filter(({ organization }) => hasUpdates(organization.id))
      .map(({ organization, secondary }) =>
        secondary ? `${organization.name} ${secondary}` : organization.name,
      ),
  ];
  const triggerLabel =
    updatedContextNames.length > 0
      ? `Workspace context: ${currentLabel}, updates in ${updatedContextNames.join(', ')}`
      : `Workspace context: ${currentLabel}`;
  const closeMenu = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const atTop = placement === 'top';

  return (
    <div className="relative w-full min-w-0">
      <div
        ref={rowRef}
        className="group/sidebar-item flex w-full items-center gap-0"
      >
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => setOpen(!open)}
          data-testid={testIds?.row ?? 'sidebar-context-row'}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-controls={open ? menuId : undefined}
          aria-label={triggerLabel}
          className={
            atTop
              ? `focus-ring flex h-8 w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-row py-0 pl-1 pr-2 text-left text-base font-bold fg-primary hover:bg-subtle focus-visible:bg-subtle aria-expanded:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11`
              : 'focus-ring flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-row px-2 text-left text-s font-normal fg-primary hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 pointer-coarse:min-h-11'
          }
        >
          <span
            className={
              atTop
                ? 'ml-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center fg-secondary'
                : 'inline-flex h-4 w-4 shrink-0 items-center justify-center fg-secondary'
            }
          >
            <SidebarContextGlyph
              kind={context.kind}
              logoUrl={current?.logoUrl}
            />
          </span>
          <span
            className={
              atTop
                ? 'min-w-0 truncate leading-snug'
                : 'min-w-0 flex-1 truncate leading-snug'
            }
            title={currentLabel}
          >
            {currentLabel}
          </span>
          {updatedContextNames.length > 0 ? (
            <UpdatesDot
              testId={testIds?.attentionDot ?? 'sidebar-context-attention-dot'}
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
        placement={atTop ? 'bottom-left' : 'top-left'}
        aria-label="Switch context"
        data-testid={testIds?.menu ?? 'sidebar-context-menu'}
        className={`pointer-coarse:[&_.canopy-dropdown-menu-item]:min-h-11 ${
          menuInstantInteractions ? 'sidebar-instant-interactions w-64' : 'w-64'
        }`}
        closeOnSelect={false}
      >
        <SidebarContextMenuItems
          context={context}
          organizations={organizations}
          contextsWithUpdates={contextsWithUpdates}
          onClose={closeMenu}
          onSelect={onSelect}
          orgScoped={orgScoped}
          disabled={disabled}
          testIds={testIds}
        />
      </FloatingMenu>
    </div>
  );
}

export interface SidebarContextMenuItemsProps {
  readonly context: WorkspaceContext;
  readonly organizations: readonly WorkspaceContextOrganization[];
  /** Called only when the choice differs from the current context. */
  readonly onSelect: (context: WorkspaceContext) => void;
  /** See {@link SidebarContextRowProps.orgScoped}. */
  readonly orgScoped: SidebarContextOrgScopedActions;
  /** Closes the host menu; called before any row's action. */
  readonly onClose: () => void;
  /** See {@link SidebarContextRowProps.contextsWithUpdates}. */
  readonly contextsWithUpdates?: ReadonlySet<string>;
  /** Disables the context options while a switch is in flight. */
  readonly disabled?: boolean;
  readonly testIds?: SidebarContextRowProps['testIds'];
}

/**
 * The organization pool's AI Credits row. Mounting (opening the menu) asks
 * the host for a fresh balance; so does a host target change while it is open.
 */
function ContextCreditsMenuItem({
  organizationId,
  credits,
  onSelect,
  testId,
}: {
  readonly organizationId: string;
  readonly credits: SidebarContextOrgScopedActions['credits'];
  readonly onSelect: () => void;
  readonly testId: string;
}): JSX.Element {
  const current = credits?.organizationId === organizationId ? credits : null;
  const refresh = current?.refresh;
  useEffect(() => {
    refresh?.();
  }, [refresh]);
  return (
    <SidebarAiCreditsMenuItem
      balanceCredits={current?.balanceCredits ?? null}
      onSelect={onSelect}
      data-testid={testId}
    />
  );
}

/**
 * The selected context's actions, in their fixed order, after a divider when
 * at least one shows. See {@link SidebarContextOrgScopedActions}.
 */
function ContextOrgScopedItems({
  actions,
  orgScoped,
  onClose,
  testIds,
}: {
  readonly actions: SidebarContextActions;
  readonly orgScoped: SidebarContextOrgScopedActions;
  readonly onClose: () => void;
  readonly testIds: SidebarContextRowProps['testIds'];
}): JSX.Element | null {
  const { onOpenPath, onCreateTeam, onInviteToTeam } = orgScoped;
  const openPath = (path: string): void => {
    onClose();
    onOpenPath(path);
  };
  const invite = actions.invite;
  let inviteClick: (() => void) | null = null;
  if (invite?.kind === 'create-team' && onCreateTeam) {
    inviteClick = (): void => {
      onClose();
      onCreateTeam();
    };
  } else if (invite?.kind === 'invite' && onInviteToTeam) {
    const organization = invite.organization;
    inviteClick = (): void => {
      onClose();
      onInviteToTeam(organization);
    };
  }
  const creditsOrganizationId = actions.creditsOrganizationId;
  if (
    actions.feedPath === null &&
    actions.statisticsPath === null &&
    !inviteClick &&
    creditsOrganizationId === null &&
    actions.settingsPath === null
  ) {
    return null;
  }
  // The actions take the action-menu rows (small text, tertiary icons); the
  // context choices above keep the picker's own rows and checkmarks.
  return (
    <>
      <DropdownMenuDivider />
      <ActionMenuRowStyle>
        {actions.feedPath !== null ? (
          <SidebarFeedMenuItem path={actions.feedPath} onOpenPath={openPath} />
        ) : null}
        {actions.statisticsPath !== null ? (
          <SidebarStatisticsMenuItem
            path={actions.statisticsPath}
            onOpenPath={openPath}
          />
        ) : null}
        {invite && inviteClick ? (
          <SidebarInviteTeamMenuItem kind={invite.kind} onClick={inviteClick} />
        ) : null}
        {creditsOrganizationId !== null ? (
          <ContextCreditsMenuItem
            organizationId={creditsOrganizationId}
            credits={orgScoped.credits}
            onSelect={(): void =>
              openPath(
                creditsBillingTargetPath({
                  kind: 'organization',
                  organizationId: creditsOrganizationId,
                }),
              )
            }
            testId={testIds?.credits ?? 'sidebar-context-menu-item-ai-credits'}
          />
        ) : null}
        {actions.settingsPath !== null ? (
          <DropdownMenuItem
            data-testid={
              testIds?.organizationSettings ??
              'sidebar-context-organization-settings'
            }
            onClick={(): void => {
              if (actions.settingsPath !== null) openPath(actions.settingsPath);
            }}
          >
            <DropdownMenuItemIcon>
              <SettingsIcon />
            </DropdownMenuItemIcon>
            Organization settings
          </DropdownMenuItem>
        ) : null}
      </ActionMenuRowStyle>
    </>
  );
}

/**
 * The context switcher's menu rows: Personal, the organizations by name,
 * Create an organization, then the selected context's actions after a divider
 * ({@link SidebarContextOrgScopedActions}).
 */
export function SidebarContextMenuItems({
  context,
  organizations,
  onSelect,
  orgScoped,
  onClose,
  contextsWithUpdates,
  disabled = false,
  testIds,
}: SidebarContextMenuItemsProps): JSX.Element {
  const options = useMemo(
    () => buildOrganizationOptions(organizations),
    [organizations],
  );
  const currentKey =
    context.kind === 'personal' ? 'personal' : context.organizationId;
  const hasUpdates = (key: string): boolean =>
    key !== currentKey && (contextsWithUpdates?.has(key) ?? false);
  const activityPrefix = testIds?.activityPrefix ?? 'sidebar-context-activity-';
  const optionPrefix =
    testIds?.optionOrganizationPrefix ?? 'sidebar-context-option-';
  const select = (next: WorkspaceContext): void => {
    onClose();
    if (!isSameWorkspaceContext(next, context)) {
      onSelect(next);
    }
  };
  const actions = resolveSidebarContextActions({
    context,
    organizations,
    authenticated: orgScoped.authenticated,
    personalOrganizationId: orgScoped.personalOrganizationId,
    freeAccess: orgScoped.freeAccess,
  });
  const createOrganizationPath = actions.createOrganizationPath;
  return (
    <>
      <DropdownMenuItem
        role="menuitemradio"
        aria-checked={context.kind === 'personal'}
        aria-label={
          hasUpdates('personal') ? 'Personal, has updates' : undefined
        }
        data-testid={
          testIds?.optionPersonal ?? 'sidebar-context-option-personal'
        }
        disabled={disabled}
        onClick={() => select({ kind: 'personal' })}
      >
        <DropdownMenuItemIcon>
          <SidebarContextGlyph kind="personal" />
        </DropdownMenuItemIcon>
        <span className="min-w-0 flex-1 truncate">Personal</span>
        {hasUpdates('personal') ? (
          <UpdatesDot testId={`${activityPrefix}personal`} />
        ) : null}
        {context.kind === 'personal' ? (
          <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
        ) : null}
      </DropdownMenuItem>
      {options.map(({ organization, secondary }) => {
        const selected =
          context.kind === 'organization' &&
          context.organizationId === organization.id;
        const updated = hasUpdates(organization.id);
        const name = secondary
          ? `${organization.name} ${secondary}`
          : organization.name;
        return (
          <DropdownMenuItem
            key={organization.id}
            role="menuitemradio"
            aria-checked={selected}
            // Spell out the identity suffix and the updates dot, which the
            // visible spans carry without separators or text.
            aria-label={
              updated ? `${name}, has updates` : secondary ? name : undefined
            }
            data-testid={`${optionPrefix}${organization.id}`}
            disabled={disabled}
            onClick={() =>
              select({
                kind: 'organization',
                organizationId: organization.id,
              })
            }
          >
            <DropdownMenuItemIcon>
              <SidebarContextGlyph
                kind="organization"
                logoUrl={organization.logoUrl}
              />
            </DropdownMenuItemIcon>
            <span className="min-w-0 flex-1 truncate">{organization.name}</span>
            {secondary ? (
              <span className="shrink-0 text-xs fg-secondary">{secondary}</span>
            ) : null}
            {updated ? (
              <UpdatesDot testId={`${activityPrefix}${organization.id}`} />
            ) : null}
            {selected ? (
              <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
            ) : null}
          </DropdownMenuItem>
        );
      })}
      {createOrganizationPath !== null ? (
        <ActionMenuRowStyle>
          <SidebarCreateOrganizationMenuItem
            onClick={(): void => {
              onClose();
              orgScoped.onOpenPath(createOrganizationPath);
            }}
          />
        </ActionMenuRowStyle>
      ) : null}
      <ContextOrgScopedItems
        actions={actions}
        orgScoped={orgScoped}
        onClose={onClose}
        testIds={testIds}
      />
    </>
  );
}
