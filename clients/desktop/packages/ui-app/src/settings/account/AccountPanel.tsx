'use client';

import { useState, type JSX } from 'react';
import { Mail, User } from '@canopy/ui-shared/icons/AppIcons';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import { useSettingsBrand, useSettingsPrivacy } from '../host';
import {
  AvatarEditor,
  NameEditor,
} from '../organization/profile/ProfileIdentityEditor';
import { useProfileEditor } from '../organization/profile/use-profile-editor';
import { withPrivacyClass } from './privacy-class';

export interface AccountPanelProps {
  /** Signed-in user's current display name (server session). */
  initialName: string;
  /** Signed-in user's current avatar URL, or `null` for initials. */
  initialImage: string | null;
  /** Signed-in user's global role (e.g. `ADMIN`), shown on the profile card. */
  role: string;
  /** Signed-in user's sign-in email, shown read-only on the account-basics tile. */
  email: string;
}

/**
 * "Account" tab content: the owner's private identity (name / avatar / role)
 * plus a read-only account-basics tile (sign-in email). The public profile and
 * billing surfaces moved to their own tabs, so this panel needs no data fetch.
 * Kept separate from `SecurityPanel` so each account tab owns its content.
 */
export function AccountPanel({
  initialName,
  initialImage,
  role,
  email,
}: AccountPanelProps): JSX.Element {
  return (
    <section className="flex flex-col gap-6">
      <ProfileSection
        initialName={initialName}
        initialImage={initialImage}
        role={role}
      />

      <AccountBasicsSection email={email} />
    </section>
  );
}

/**
 * Read-only "Account" tile showing the email the user signs in with. Sign-in
 * methods, password, and 2FA are managed on the Security tab; this is just the
 * at-a-glance identity value so the Account tab isn't a single card.
 */
export function AccountBasicsSection({
  email,
}: {
  email: string;
}): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  return (
    <SettingsCard
      icon={<Mail size={18} />}
      title="Contact information"
      subtitle="Your primary email address, where we send account and billing notifications."
      testId="account-basics-section"
    >
      {/* No inline glyph: the card's accent medallion already carries the
          "this is an email" cue. */}
      <span
        className={withPrivacyClass('text-s fg-primary', blockClassName)}
        data-testid="account-email"
      >
        {email}
      </span>
    </SettingsCard>
  );
}

interface ProfileSectionProps {
  initialName: string;
  initialImage: string | null;
  role: string;
}

/**
 * Owner-editable display name + avatar, sharing the same upload/commit/PATCH
 * transport ({@link useProfileEditor}) and editor UI as the member profile
 * header. Initial values come from the server session; edits update the local
 * preview immediately and propagate site-wide on the next navigation.
 */
export function ProfileSection({
  initialName,
  initialImage,
  role,
}: ProfileSectionProps): JSX.Element {
  const [name, setName] = useState(initialName);
  const [image, setImage] = useState<string | null>(initialImage);
  const editor = useProfileEditor();
  const brandName = useSettingsBrand().displayName;

  const handlePick = (file: File): void => {
    void editor.uploadAvatar(file).then((url) => {
      if (url) setImage(url);
    });
  };

  const handleRemove = (): void => {
    void editor.removeAvatar().then((ok) => {
      if (ok) setImage(null);
    });
  };

  const handleSaveName = (next: string): void => {
    void editor.updateName(next).then((saved) => {
      if (saved) setName(saved);
    });
  };

  // Titled "Basic info", not "Account": the page header above already says
  // Account, and a card heading that repeats the page title carries no
  // information.
  return (
    <SettingsCard
      icon={<User size={18} />}
      title="Basic info"
      subtitle={`Choose how your name and profile picture will appear on ${brandName}.`}
      testId="account-profile-section"
    >
      <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
        <AvatarEditor
          name={name}
          image={image}
          busy={editor.busy}
          error={editor.error}
          onPick={handlePick}
          onRemove={handleRemove}
        />
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          <NameEditor
            name={name}
            busy={editor.busy}
            error={editor.error}
            onOpen={editor.clearError}
            onSave={handleSaveName}
          />
          <span
            className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium fg-accent"
            data-testid="account-role"
          >
            {capitalizeFirstLetter(role.toLowerCase())}
          </span>
        </div>
      </div>
    </SettingsCard>
  );
}
