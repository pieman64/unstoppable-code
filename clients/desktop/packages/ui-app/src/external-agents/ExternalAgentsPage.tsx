'use client';

import type { JSX } from 'react';
import { useStore } from 'zustand';
import { useCanopyClient, useCapabilities } from '@canopy/app-state';
import {
  createExternalAgentsOverviewStore,
  type ExternalAgentsOverviewStore,
} from '@canopy/app-state/external-agents';
import type { ExternalAgentsClient } from '@canopy/app-core';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import {
  AgentRow,
  ConnectSection,
  ExternalAgentsUnavailable,
  NoticeList,
  SettingsGroup,
  SettingsSection,
  WaitingRows,
} from './external-agents-parts';
import { ExternalAgentsOverviewSkeleton } from './external-agents-skeletons';
import { externalAgentPath } from './paths';
import { useMountedStore } from './use-mounted-store';

export interface ExternalAgentsPageProps {
  readonly onOpenPath: (path: string) => void;
}

export function ExternalAgentsPage({
  onOpenPath,
}: ExternalAgentsPageProps): JSX.Element {
  const client = useCanopyClient();
  const capabilities = useCapabilities();
  const externalAgents = client.externalAgents;
  if (capabilities.externalAgents !== true || externalAgents === undefined) {
    return <ExternalAgentsUnavailable />;
  }

  return (
    <ExternalAgentsOverviewContent
      client={externalAgents}
      onOpenPath={onOpenPath}
    />
  );
}

function ExternalAgentsOverviewContent({
  client,
  onOpenPath,
}: {
  readonly client: ExternalAgentsClient;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const store = useMountedStore(client, 'overview', (agents) =>
    createExternalAgentsOverviewStore(agents),
  );
  if (store === null) {
    return (
      <div
        data-testid="external-agents-page"
        className="flex w-full flex-col pb-16"
      >
        <ExternalAgentsOverviewSkeleton />
      </div>
    );
  }
  return <ExternalAgentsOverviewView store={store} onOpenPath={onOpenPath} />;
}

function ExternalAgentsOverviewView({
  store,
  onOpenPath,
}: {
  readonly store: ExternalAgentsOverviewStore;
  readonly onOpenPath: (path: string) => void;
}): JSX.Element {
  const state = useStore(store);

  const overview = state.overview;
  const isInitialLoading = overview === null && state.status !== 'problem';

  return (
    <div
      data-testid="external-agents-page"
      className="flex w-full flex-col gap-10 pb-16"
    >
      {state.status !== 'loading' && state.problem !== null ? (
        <Notice
          intent="attention"
          actions={
            <NoticeButton
              variant="secondary"
              data-testid="external-agents-retry"
              onClick={(): void => void state.load()}
            >
              Try again
            </NoticeButton>
          }
          data-testid="external-agents-error"
        >
          Couldn’t load your agents.
        </Notice>
      ) : null}

      {overview ? (
        <NoticeList notices={overview.notices} onOpenPath={onOpenPath} />
      ) : null}

      {overview && overview.waiting.length > 0 ? (
        <SettingsSection
          title="Waiting for you"
          description="An agent asked to do something that needs your confirmation."
          testId="external-agents-waiting"
        >
          <WaitingRows
            waiting={overview.waiting}
            onOpenPath={onOpenPath}
            showAgent
          />
        </SettingsSection>
      ) : null}

      {overview && overview.connections.length > 0 ? (
        <SettingsSection title="Agents" testId="external-agents-list">
          <SettingsGroup>
            {overview.connections.map((connection) => (
              <AgentRow
                key={connection.id}
                connection={connection}
                onOpen={(): void =>
                  onOpenPath(externalAgentPath(connection.id))
                }
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      ) : null}

      {overview ? (
        <ConnectSection
          servers={overview.servers}
          cursorClientId={overview.cursorClientId}
        />
      ) : isInitialLoading ? (
        <ExternalAgentsOverviewSkeleton />
      ) : null}
    </div>
  );
}
