'use client';

import type { JSX, ReactNode } from 'react';
import {
  INSTALL_UPDATE_EMAILS_TITLE,
  InstallUpdateEmailsSetting,
} from '../InstallUpdateEmailsSetting';
import { Mail } from '@canopy/ui-shared/icons/AppIcons';
import { SettingsCard } from '@canopy/ui-shared/components/settings/SettingsCard';

function renderCardFrame(content: ReactNode): ReactNode {
  return (
    <SettingsCard
      icon={<Mail size={18} />}
      title={INSTALL_UPDATE_EMAILS_TITLE}
      testId="account-install-update-emails"
    >
      {content}
    </SettingsCard>
  );
}

/**
 * The shared "Updates to things I've installed" row (CAN-2334) in the web
 * Account → Notifications card chrome, so it sits like the Work digests and
 * Push notifications cards beside it. Desktop mounts the same row in its
 * Settings-kit section.
 */
export function InstallUpdateEmailsSection(): JSX.Element {
  return <InstallUpdateEmailsSetting renderFrame={renderCardFrame} />;
}
