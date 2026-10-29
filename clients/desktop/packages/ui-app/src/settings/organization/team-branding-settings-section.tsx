'use client';

import { type JSX } from 'react';
import { Image as ImageIcon } from '@canopy/ui-shared/icons/AppIcons';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';
import { canEditOrg } from '@canopy/protocol/settings/organization-permissions';
import { useSettingsBrand } from '../host';
import { OrganizationLogoEditor } from './OrganizationLogoEditor';
import { useOrgLogoEditor } from './use-org-logo-editor';

interface TeamBrandingSettingsSectionProps {
  detail: OrganizationDetail;
  onDetailChange: (detail: OrganizationDetail) => void;
}

/**
 * Owner/admin control for the organization's appearance. Today it holds the
 * moderated logo upload/remove; it is named "branding" (not "logo") so future
 * theme/palette controls join this same panel. Setting or clearing the logo
 * returns a fresh {@link OrganizationDetail} which replaces the in-memory
 * detail so the org-page header updates immediately.
 */
export function TeamBrandingSettingsSection({
  detail,
  onDetailChange,
}: TeamBrandingSettingsSectionProps): JSX.Element | null {
  const brand = useSettingsBrand();
  const logoEditor = useOrgLogoEditor(detail.id);

  if (!canEditOrg(detail.viewerRole)) {
    return null;
  }

  const handlePick = (file: File): void => {
    void logoEditor.uploadLogo(file).then((updated) => {
      if (updated) {
        onDetailChange(updated);
      }
    });
  };

  const handleRemove = (): void => {
    void logoEditor.removeLogo().then((updated) => {
      if (updated) {
        onDetailChange(updated);
      }
    });
  };

  return (
    <section
      className="rounded-xl bg-card p-5 shadow-sm"
      data-testid="team-branding-settings-section"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-subtle fg-accent">
          <ImageIcon size={18} />
        </span>
        <div className="flex-1">
          <h2 className="text-m font-semibold fg-primary">
            Organization branding
          </h2>
          <p className="mt-1 text-s fg-secondary">
            Upload a logo to represent your organization across{' '}
            {brand.displayName}. PNG, JPEG, or GIF up to 5 MB; it&apos;s shown
            as a rounded square and wide logos are center-cropped.
          </p>

          <div className="mt-4 flex justify-start">
            <OrganizationLogoEditor
              name={detail.name}
              logoUrl={detail.logoUrl}
              size={72}
              busy={logoEditor.busy}
              error={logoEditor.error}
              onPick={handlePick}
              onRemove={handleRemove}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
