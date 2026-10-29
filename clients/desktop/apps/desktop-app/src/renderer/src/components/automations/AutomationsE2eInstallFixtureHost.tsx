import { type JSX, useEffect, useState } from 'react';
import type { SharedAutomationDetail } from '@canopy/protocol/automations';
import { useAutomationScope } from '@/hooks/useAutomationScope';
import {
  localBadgeForSummary,
  staleCopiesOf,
} from '@/lib/automationShareRelationship';
import {
  AUTOMATIONS_E2E_INSTALL_FIXTURE_EVENT,
  parseAutomationsE2eInstallFixture,
} from '@/lib/automationsE2eInstallFixture';
import { toInstallWorkspaceOptions } from '@/lib/installWorkspaceOptions';
import { useAutomationsStore } from '@/stores/automationsStore';
import { requestAutomationProjectCreation } from '@/stores/automationInstallContinuationStore';
import { InstallSharedAutomationModal } from './InstallSharedAutomationModal';

/**
 * Opens the real install wizard for a fixture share injected through
 * {@link AUTOMATIONS_E2E_INSTALL_FIXTURE_EVENT}. Mounted only in E2E builds,
 * from the always-mounted install continuation host, so a spec can inject a
 * fixture from any page. Like the retired Automations › Shared tab, it
 * updates in place only when an installed copy is stale; a current copy gets
 * an independent new one.
 */
export function AutomationsE2eInstallFixtureHost(): JSX.Element | null {
  const [detail, setDetail] = useState<SharedAutomationDetail | null>(null);
  const activities = useAutomationsStore((state) => state.activities);
  const scope = useAutomationScope();

  useEffect(() => {
    const store = useAutomationsStore.getState();
    const unsubscribe = store.subscribeBridge();
    if (!store.hydrated && !store.loading) {
      void store.hydrate();
    }
    return unsubscribe;
  }, []);

  useEffect(() => {
    const onInstallFixture = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const fixture = parseAutomationsE2eInstallFixture(event.detail);
      if (fixture) setDetail(fixture);
    };
    window.addEventListener(
      AUTOMATIONS_E2E_INSTALL_FIXTURE_EVENT,
      onInstallFixture,
    );
    return (): void => {
      window.removeEventListener(
        AUTOMATIONS_E2E_INSTALL_FIXTURE_EVENT,
        onInstallFixture,
      );
    };
  }, []);

  if (!detail) return null;
  return (
    <InstallSharedAutomationModal
      onCreateProject={requestAutomationProjectCreation}
      detail={detail}
      staleActivities={
        localBadgeForSummary(detail, activities) === 'update-available'
          ? staleCopiesOf(activities, {
              sourceKind: 'shared',
              remoteId: detail.id,
              contentHash: detail.contentHash,
            })
          : []
      }
      workspaces={toInstallWorkspaceOptions(scope.projectsInContext)}
      onClose={(): void => setDetail(null)}
      onDone={(): void => {
        // The automations store refreshes through the service broadcast.
      }}
    />
  );
}
