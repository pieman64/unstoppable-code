import type { JSX } from 'react';
import { AccountProxyFailureNotice } from '@canopy/ui-shared/components';
import { useNavigationStore } from '@/stores/navigationStore';

/** The shared account proxy failure notice, with the desktop's settings action. */
export function AccountProxyFailureNoticeAction({
  text,
}: {
  /** The `Error:` row's text. */
  readonly text: string;
}): JSX.Element {
  const openSettings = useNavigationStore((state) => state.openSettings);
  return (
    <AccountProxyFailureNotice
      message={text.replace(/^Error:\s*/, '')}
      onOpenSettings={(): void => openSettings('account-proxy')}
    />
  );
}
