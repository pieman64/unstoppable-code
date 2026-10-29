'use client';

import { useState, type FormEvent, type JSX } from 'react';
import { Check, X } from '@canopy/ui-shared/icons/AppIcons';
import { ErrorBanner } from '@canopy/ui-shared/components';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import { canEditOrg } from '@canopy/protocol/settings/organization-permissions';
import { useSettingsClient } from '../host';
import { useSettingsErrorCopy } from '../errors';
import {
  ORGANIZATION_HEADER_LOGO_SIZE,
  OrganizationIdentity,
  OrganizationRenameButton,
} from './organization-header';
import { renameOrganization } from './team-api';
import { OrganizationLogo } from './OrganizationLogo';
import { OrganizationLogoEditor } from './OrganizationLogoEditor';
import { useOrgLogoEditor } from './use-org-logo-editor';

interface TeamOverviewSectionProps {
  detail: OrganizationDetail;
  onDetailChange: (detail: OrganizationDetail) => void;
}

/**
 * Compact team-page header: the organization name (inline-editable for ADMIN+),
 * the viewer's role, and small member / team counts. Rendered as a lightweight
 * page title rather than a card. The OWNER-only delete action lives in
 * `TeamDangerZone` at the bottom of the page.
 *
 * A rename or logo error shows below the block rather than inside it, so the
 * block keeps its height and the page header below it never shifts row by
 * row inside the organization block.
 */
export function TeamOverviewSection({
  detail,
  onDetailChange,
}: TeamOverviewSectionProps): JSX.Element {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy('settings.organization.overview');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(detail.name);
  const [savingName, setSavingName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logoEditor = useOrgLogoEditor(detail.id);

  const editable = canEditOrg(detail.viewerRole);
  const memberCount = detail.members.length;
  const groupCount = detail.subTeams.length;

  const startEdit = (): void => {
    setName(detail.name);
    setError(null);
    setEditing(true);
  };

  const handlePickLogo = (file: File): void => {
    void logoEditor.uploadLogo(file).then((updated) => {
      if (updated) {
        onDetailChange(updated);
      }
    });
  };

  const handleRename = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || trimmed === detail.name) {
      setEditing(false);
      return;
    }
    try {
      setSavingName(true);
      setError(null);
      const updated = await renameOrganization(client, detail.id, trimmed);
      onDetailChange(updated);
      setEditing(false);
    } catch (err) {
      setError(
        errorCopy.actionCopy(err, { action: 'rename the organization' }),
      );
    } finally {
      setSavingName(false);
    }
  };

  return (
    <>
      <OrganizationIdentity
        organizationId={detail.id}
        name={detail.name}
        viewerRole={detail.viewerRole}
        memberCount={memberCount}
        teamCount={groupCount}
        logo={
          editable ? (
            <OrganizationLogoEditor
              name={detail.name}
              logoUrl={detail.logoUrl}
              size={ORGANIZATION_HEADER_LOGO_SIZE}
              busy={logoEditor.busy}
              // Shown in the banner below the block instead, so a long message
              // never stretches the logo column.
              error={null}
              onPick={handlePickLogo}
            />
          ) : (
            <OrganizationLogo
              name={detail.name}
              logoUrl={detail.logoUrl}
              size={ORGANIZATION_HEADER_LOGO_SIZE}
            />
          )
        }
        nameEditor={
          editing ? (
            <form onSubmit={handleRename} className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                required
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="team-name-input"
                className="rounded-md border bg-card px-3 py-1.5 text-2xl font-semibold fg-primary"
              />
              <button
                type="submit"
                disabled={savingName || !name.trim()}
                aria-label="Save name"
                className="rounded-md bg-accent p-2 fg-emphasis transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                onClick={() => setEditing(false)}
                aria-label="Cancel"
                className="rounded-md border p-2 fg-primary transition-colors hover:bg-secondary"
              >
                <X size={16} />
              </button>
            </form>
          ) : undefined
        }
        nameAction={
          editable ? (
            <OrganizationRenameButton onClick={startEdit} />
          ) : undefined
        }
      />
      <ErrorBanner className="" error={error ?? logoEditor.error} />
    </>
  );
}
