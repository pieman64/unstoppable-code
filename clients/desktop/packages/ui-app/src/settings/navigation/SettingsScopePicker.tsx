'use client';

import { useId, useMemo, useRef, useState, type JSX } from 'react';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuItemTrailing,
  DropdownMenuLabel,
  FloatingMenu,
} from '@canopy/ui-shared/components';
import {
  BuildingIcon,
  CheckIcon,
  ChevronsUpDown,
  Plus,
} from '@canopy/ui-shared/icons/AppIcons';
import type { SettingsNavModel } from '@canopy/protocol/settings';
import { useOptionalSettingsHost } from '../host/settings-host';
import { MemberAvatar } from '../organization/MemberAvatar';
import { OrganizationLogo } from '../organization/OrganizationLogo';
import { ROLE_LABEL } from '../organization/team-role-label';
import {
  accountScopeHref,
  currentSettingsNavScope,
  organizationScopeHref,
  settingsNavScopeOrganizations,
} from './settings-nav-scope';

const ORGANIZATIONS_PATH = '/organization';
const CREATE_ORGANIZATION_PATH = `${ORGANIZATIONS_PATH}?create=1`;

export interface SettingsScopePickerProps {
  readonly model: SettingsNavModel;
  /** The current settings path with its query, e.g. `/account/billing`. */
  readonly currentPath: string;
  /** Opens a settings path in the host (router push). */
  readonly onNavigate: (href: string) => void;
  /**
   * Explicitly choosing an organization selects it in the main sidebar, as
   * the organization header's switcher did.
   */
  readonly onSelectOrganization?: (organizationId: string) => void;
  /** Test-id prefix shared with the rail rows. */
  readonly testIdPrefix: string;
  /**
   * Session-replay mask for user-authored organization names (desktop). The
   * account scope shows a person's name, which takes the host's block class.
   */
  readonly maskClassName?: string;
}

/**
 * The top of the settings rail: which scope the rows below belong to, your
 * account or one organization, with a menu to switch. Switching keeps the
 * page when both scopes have it (Billing, Integrations) and otherwise opens
 * the scope's first page. The menu also leads to the full Organizations list
 * and to creating an organization.
 */
export function SettingsScopePicker({
  model,
  currentPath,
  onNavigate,
  onSelectOrganization,
  testIdPrefix,
  maskClassName = '',
}: SettingsScopePickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const blockClassName =
    useOptionalSettingsHost()?.privacy.blockClassName ?? '';
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const scope = currentSettingsNavScope(model);
  const organizations = useMemo(
    () => settingsNavScopeOrganizations(model),
    [model],
  );
  const viewerName =
    model.viewer?.name?.trim() || model.viewer?.email || 'Personal account';
  const onListPage = currentPath.split(/[?#]/, 1)[0] === ORGANIZATIONS_PATH;

  const go = (href: string): void => {
    setOpen(false);
    onNavigate(href);
  };

  const title = scope.kind === 'account' ? viewerName : scope.name;
  // A person's name or email is blocked in replay, and is not repeated in a
  // title attribute, which replay records unmasked.
  const titleClassName =
    scope.kind === 'account' ? blockClassName : maskClassName;
  const subtitle =
    scope.kind === 'account'
      ? 'Personal account'
      : scope.isPersonal
        ? 'Your activity and usage'
        : scope.role === null
          ? 'Organization'
          : `Organization · ${ROLE_LABEL[scope.role]}`;

  return (
    <div ref={anchorRef} className="relative mt-2">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        data-settings-control="picker"
        data-testid={`${testIdPrefix}scope-picker`}
        // Web gives every button a hand cursor; rail controls keep the arrow.
        className="focus-ring flex w-full min-w-0 cursor-default items-center gap-2.5 rounded-row px-2 py-2 text-left hover:bg-subtle aria-expanded:bg-subtle pointer-coarse:min-h-11"
      >
        {scope.kind === 'account' ? (
          <MemberAvatar
            name={viewerName}
            image={model.viewer?.image ?? null}
            size={24}
            maxInitials={1}
            className="shrink-0"
          />
        ) : (
          <OrganizationLogo
            name={scope.name}
            logoUrl={scope.logoUrl}
            size={24}
            maxInitials={1}
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={`truncate text-s font-medium fg-primary ${titleClassName}`}
            title={scope.kind === 'account' ? undefined : title}
            data-testid={`${testIdPrefix}scope-title`}
          >
            {title}
          </span>
          <span className="truncate text-xs fg-tertiary">{subtitle}</span>
        </span>
        <ChevronsUpDown
          size={14}
          aria-hidden="true"
          className="shrink-0 fg-tertiary"
        />
      </button>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        returnFocusRef={triggerRef}
        placement="bottom-left"
        aria-label="Switch settings"
        data-testid={`${testIdPrefix}scope-menu`}
        // The menu spans the trigger, as wide as the rail's rows.
        className="w-[var(--floating-menu-anchor-width)] min-w-60 pointer-coarse:[&_.canopy-dropdown-menu-item]:min-h-11"
      >
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={scope.kind === 'account' && !onListPage}
          data-testid={`${testIdPrefix}scope-option-account`}
          onClick={() => go(accountScopeHref(currentPath, model.account))}
        >
          <DropdownMenuItemIcon>
            <MemberAvatar
              name={viewerName}
              image={model.viewer?.image ?? null}
              size={16}
              maxInitials={1}
            />
          </DropdownMenuItemIcon>
          <span className="min-w-0 flex-1 truncate">Personal account</span>
          {scope.kind === 'account' && !onListPage ? (
            <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
          ) : null}
        </DropdownMenuItem>
        {organizations.length > 0 ? (
          <>
            <DropdownMenuDivider />
            <DropdownMenuLabel>Organizations</DropdownMenuLabel>
            {organizations.map((organization) => {
              const selected =
                scope.kind === 'organization' &&
                scope.organizationId === organization.id;
              return (
                <DropdownMenuItem
                  key={organization.id}
                  role="menuitemradio"
                  aria-checked={selected}
                  data-testid={`${testIdPrefix}scope-option-${organization.id}`}
                  onClick={() => {
                    if (selected) {
                      setOpen(false);
                      return;
                    }
                    onSelectOrganization?.(organization.id);
                    go(organizationScopeHref(currentPath, organization));
                  }}
                >
                  <DropdownMenuItemIcon>
                    {organization.logoUrl ? (
                      <OrganizationLogo
                        name={organization.name}
                        logoUrl={organization.logoUrl}
                        size={16}
                        maxInitials={1}
                      />
                    ) : (
                      <BuildingIcon />
                    )}
                  </DropdownMenuItemIcon>
                  <span className={`min-w-0 flex-1 truncate ${maskClassName}`}>
                    {organization.name}
                  </span>
                  <DropdownMenuItemTrailing>
                    {ROLE_LABEL[organization.role]}
                  </DropdownMenuItemTrailing>
                  {selected ? (
                    <CheckIcon
                      size={16}
                      aria-hidden="true"
                      className="shrink-0"
                    />
                  ) : null}
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}
        <DropdownMenuDivider />
        <DropdownMenuItem
          role="menuitemradio"
          aria-checked={onListPage}
          data-testid={`${testIdPrefix}scope-all-organizations`}
          onClick={() => go(ORGANIZATIONS_PATH)}
        >
          <DropdownMenuItemIcon>
            <BuildingIcon />
          </DropdownMenuItemIcon>
          <span className="min-w-0 flex-1 truncate">All organizations</span>
          {onListPage ? (
            <CheckIcon size={16} aria-hidden="true" className="shrink-0" />
          ) : null}
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={`${testIdPrefix}scope-create-organization`}
          onClick={() => go(CREATE_ORGANIZATION_PATH)}
        >
          <DropdownMenuItemIcon>
            <Plus />
          </DropdownMenuItemIcon>
          Create an organization
        </DropdownMenuItem>
      </FloatingMenu>
    </div>
  );
}
