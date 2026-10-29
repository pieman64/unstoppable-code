import { type JSX, useCallback, useEffect, useState } from 'react';
import { MEMORY_SEARCH_CAPABILITY } from '@canopy/protocol/memory';
import { normalizeMemorySearchOrganizationExternalIds } from '@canopy/desktop-shared/lib/org-memory';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { ToggleSwitch } from '@canopy/ui-shared/components';
import { findOrganizationName } from '@/lib/organizationName';
import { useWorkspaceContext } from '@/stores/workspaceContextStore';
import { DesktopDataSharingOptIn } from './DesktopDataSharingOptIn';
import { resolveOrgMemoryOptInOrganization } from './dataSharingOptIn';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

const TOGGLE_ID = 'settings-org-memory-enabled';
const TOGGLE_LABEL = 'Use organization memory';

/**
 * Names of the organizations whose projects may use organization memory, in
 * the account's eligibility order (CAN-3457). Memory is searched only in the
 * org that owns a chat's project, so the copy names those orgs instead of a
 * single "your organization".
 */
function eligibleOrgMemoryOrganizationNames(
  account: Pick<
    CanopyCloudAccountPublicState,
    | 'memorySearchOrganizationExternalIds'
    | 'memorySearchOrganizationExternalId'
    | 'organizations'
  >,
): string[] {
  // Same normalization main applies before searching, so the copy names
  // exactly the organizations a search can reach.
  const ids = normalizeMemorySearchOrganizationExternalIds(
    account.memorySearchOrganizationExternalIds,
    account.memorySearchOrganizationExternalId,
  );
  const names: string[] = [];
  for (const id of ids) {
    const name = findOrganizationName(account.organizations, id);
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** Joins names as "A and B" or "A, B, and C". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function orgMemoryDescription(names: readonly string[]): string {
  if (names.length === 0) {
    return 'Add relevant knowledge from past sessions to chats in organization projects';
  }
  if (names.length === 1) {
    return `Add relevant knowledge from past sessions to chats in ${names[0]}'s projects`;
  }
  return `Add relevant knowledge from past sessions to chats in projects owned by ${joinNames(names)}. Each project uses only its own organization's memory.`;
}

export function OrgMemorySettings(): JSX.Element {
  const [available, setAvailable] = useState(false);
  const [organizationNames, setOrganizationNames] = useState<string[]>([]);
  const [eligibleOrganizationIds, setEligibleOrganizationIds] = useState<
    string[]
  >([]);
  const workspaceContext = useWorkspaceContext();
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void window.api
      .loadCanopyCloudAccount()
      .then((account) => {
        if (cancelled) return;
        setAvailable(account.capabilities.includes(MEMORY_SEARCH_CAPABILITY));
        setOrganizationNames(eligibleOrgMemoryOrganizationNames(account));
        setEligibleOrganizationIds(
          normalizeMemorySearchOrganizationExternalIds(
            account.memorySearchOrganizationExternalIds,
            account.memorySearchOrganizationExternalId,
          ),
        );
      })
      .catch(() => {
        // Keep capability-gated controls unavailable when account state
        // cannot be loaded.
      });
    void window.api
      .loadPreferences()
      .then((preferences) => {
        if (cancelled) return;
        setEnabled(preferences.orgMemoryInjectionEnabled);
      })
      .catch(() => {
        // Keep the enabled-by-default state when preferences cannot load.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const handleEnabledChange = useCallback((nextEnabled: boolean): void => {
    setEnabled(nextEnabled);
    void window.api.savePreferences({
      orgMemoryInjectionEnabled: nextEnabled,
    });
  }, []);

  const optInOrganizationId = resolveOrgMemoryOptInOrganization(
    eligibleOrganizationIds,
    workspaceContext,
  );

  return (
    <SettingsSection
      title="Organization memory"
      dataTestId="org-memory-settings"
    >
      <SettingsGroup>
        <SettingsRow
          label={TOGGLE_LABEL}
          htmlFor={TOGGLE_ID}
          description={
            <>
              <span data-testid="org-memory-organization-names">
                {orgMemoryDescription(available ? organizationNames : [])}
              </span>
              {!available && (
                <span className="block">Not available for your account</span>
              )}
            </>
          }
          control={
            <ToggleSwitch
              id={TOGGLE_ID}
              checked={enabled}
              disabled={!available}
              label={TOGGLE_LABEL}
              onChange={handleEnabledChange}
              dataTestId="org-memory-enabled-toggle"
            />
          }
        />
      </SettingsGroup>
      {available && optInOrganizationId !== null && (
        <DesktopDataSharingOptIn
          feature="organization-memory"
          organizationId={optInOrganizationId}
          className="mt-2"
        />
      )}
    </SettingsSection>
  );
}
