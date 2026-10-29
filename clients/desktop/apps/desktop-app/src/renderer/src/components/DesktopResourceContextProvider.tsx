import { useEffect, useState, type JSX, type ReactNode } from 'react';
import { ResourceContextProvider } from '@canopy/ui-app/capability';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import { useSidebarScopingContext } from './sidebar/useSidebarScopingContext';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

export function DesktopResourceContextProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const context = useSidebarScopingContext();
  const scopingEnabled = useCanopyOrgProjectsEnabled();
  const scopingHydrated = useWorkspaceContextStore((state) => state.hydrated);
  const [personalOrganizationId, setPersonalOrganizationId] = useState<
    string | null
  >(null);
  useEffect(() => {
    let latest = 0;
    let cancelled = false;
    const refresh = (): void => {
      const sequence = ++latest;
      void window.api
        .loadCanopyCloudAccount()
        .then((account) => {
          if (
            cancelled ||
            latest !== sequence ||
            !isConclusiveAccountRead(account)
          )
            return;
          setPersonalOrganizationId(
            account.account && !isGuestAccount(account)
              ? (account.personalOrganizationId ?? null)
              : null,
          );
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    return (): void => {
      cancelled = true;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    };
  }, []);
  return (
    <ResourceContextProvider
      context={context}
      personalOrganizationId={personalOrganizationId}
      ready={!scopingEnabled || scopingHydrated}
    >
      {children}
    </ResourceContextProvider>
  );
}
