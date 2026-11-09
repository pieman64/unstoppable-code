import type { JSX } from 'react';
import type { ExternalAgentConnectionSummary } from '@canopy/protocol/external-agents';
import { Button, Skeleton } from '@canopy/ui-shared/components';
import {
  AgentRow,
  BackRow,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
} from './external-agents-parts';

/**
 * Loading states for the External agents pages. Each renders the page's own
 * parts with sample data inside `Skeleton`, so skullet measures them into
 * bars and blocks and the loaded page replaces the skeleton in place. The
 * samples never show: skullet draws over them, unseen and inert.
 */

const noop = (): void => undefined;

const SAMPLE_CONNECTIONS: readonly ExternalAgentConnectionSummary[] = [
  {
    id: 'sample-agent-1',
    server: 'account',
    clientName: 'Release notes agent',
    label: null,
    verified: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    access: {
      read: ['account', 'usage'],
      write: [],
      destructive: [],
      organizations: 'all',
      desktops: null,
      managed: null,
    },
  },
  {
    id: 'sample-agent-2',
    server: 'tasks',
    clientName: 'Triage agent',
    label: null,
    verified: true,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: null,
    access: {
      read: [],
      write: ['library'],
      destructive: [],
      organizations: null,
      desktops: 'all',
      managed: true,
    },
  },
];

const SAMPLE_SETTINGS = [
  ['What it can read', 'Account details and usage across your organizations'],
  ['What it can change', 'Nothing yet'],
  ['Confirmation', 'Asks you before it changes anything'],
] as const;

function SampleSettingsSection(): JSX.Element {
  return (
    <SettingsSection title="Access">
      <SettingsGroup>
        {SAMPLE_SETTINGS.map(([label, description]) => (
          <SettingsRow key={label} label={label} description={description} />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}

/** The agents list: a section of agent rows. */
export function ExternalAgentsOverviewSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading agents"
      testId="external-agents-loading"
      className="w-full"
    >
      <SettingsSection title="Agents">
        <SettingsGroup>
          {SAMPLE_CONNECTIONS.map((connection) => (
            <AgentRow
              key={connection.id}
              connection={connection}
              onOpen={noop}
            />
          ))}
        </SettingsGroup>
      </SettingsSection>
    </Skeleton>
  );
}

/** One agent: the back row and its actions, the agent, and its access. */
export function ExternalAgentSkeleton(): JSX.Element {
  const [sample] = SAMPLE_CONNECTIONS;
  return (
    <div className="w-full pb-16">
      <Skeleton
        loading
        label="Loading agent"
        testId="external-agent-loading"
        className="w-full"
      >
        <BackRow
          onBack={noop}
          actions={
            <>
              <Button variant="destructive" size="compact">
                Remove
              </Button>
              <Button variant="secondary" size="compact">
                Pause
              </Button>
            </>
          }
        />
        <div className="flex w-full flex-col gap-10 pt-6">
          {sample ? (
            <SettingsGroup>
              <AgentRow connection={sample} onOpen={noop} />
            </SettingsGroup>
          ) : null}
          <SampleSettingsSection />
        </div>
      </Skeleton>
    </div>
  );
}

/** A request waiting for confirmation: the agent and what it asks for. */
export function ExternalAgentConfirmationSkeleton(): JSX.Element {
  const [sample] = SAMPLE_CONNECTIONS;
  return (
    <Skeleton
      loading
      label="Loading request"
      testId="external-agent-confirmation-loading"
      className="w-full"
    >
      <div className="flex w-full flex-col gap-6">
        {sample ? (
          <SettingsGroup>
            <AgentRow connection={sample} onOpen={noop} />
          </SettingsGroup>
        ) : null}
        <SampleSettingsSection />
      </div>
    </Skeleton>
  );
}
