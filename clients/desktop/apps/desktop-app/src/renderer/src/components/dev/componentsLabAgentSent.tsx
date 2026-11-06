import type { ComponentProps, JSX } from 'react';
import {
  AgentSentReceivingContextProvider,
  AgentSentSenderOpenerProvider,
  AgentSentTitle,
  LifetimeLimitNoticeDisplay,
  type AgentSentReceivingContext,
  type AgentSentSenderOpener,
} from '@canopy/ui-shared';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

const noop = (): void => undefined;

const AGENT_SENT: ComponentProps<typeof AgentSentTitle>['agentSent'] = {
  sender: {
    kind: 'bot',
    botId: 'app_advisor',
    taskId: 'lab-task',
    chatId: 'lab-chat',
  },
  chatTitle: 'Review the release notes',
  projectLabel: 'Orchestrator',
};

const RECEIVING: AgentSentReceivingContext = {
  kind: 'project',
  projectId: 'lab-project',
};

const OPENER: AgentSentSenderOpener = { canOpen: () => true, open: noop };

const LIMIT_STATES: readonly {
  label: string;
  props: ComponentProps<typeof LifetimeLimitNoticeDisplay>;
}[] = [
  { label: 'Gated', props: { state: 'gated' } },
  { label: 'Unavailable', props: { state: 'unavailable' } },
  {
    label: 'Full, can extend',
    props: { state: 'full', canExtend: true, atCap: false, onExtend: noop },
  },
  {
    label: 'Full, extending',
    props: {
      state: 'full',
      canExtend: true,
      atCap: false,
      extension: 'pending',
      onExtend: noop,
    },
  },
  {
    label: 'Full, extension failed',
    props: {
      state: 'full',
      canExtend: true,
      atCap: false,
      extension: 'failed',
      onExtend: noop,
    },
  },
  {
    label: 'Full, outcome unknown',
    props: {
      state: 'full',
      canExtend: true,
      atCap: false,
      extension: 'uncertain',
      onExtend: noop,
    },
  },
  {
    label: 'Full, at the cap',
    props: { state: 'full', canExtend: false, atCap: true },
  },
];

/** The title row of a message another agent sent, and the lifetime notice. */
export function AgentSentSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SpecimenPanel title="AgentSentTitle">
        <AgentSentReceivingContextProvider receivingContext={RECEIVING}>
          <AgentSentSenderOpenerProvider opener={OPENER}>
            <SpecimenGrid min={280}>
              <SpecimenCell label="Block">
                <AgentSentTitle
                  agentSent={AGENT_SENT}
                  receivingContext={RECEIVING}
                />
              </SpecimenCell>
              <SpecimenCell label="Inline">
                <span className="text-xs">
                  <AgentSentTitle
                    agentSent={AGENT_SENT}
                    receivingContext={RECEIVING}
                    layout="inline"
                  />
                </span>
              </SpecimenCell>
              <SpecimenCell label="Steering">
                <AgentSentTitle
                  agentSent={AGENT_SENT}
                  receivingContext={RECEIVING}
                  steering
                />
              </SpecimenCell>
            </SpecimenGrid>
          </AgentSentSenderOpenerProvider>
        </AgentSentReceivingContextProvider>
      </SpecimenPanel>
      <SpecimenPanel title="LifetimeLimitNoticeDisplay">
        {LIMIT_STATES.map(({ label, props }) => (
          <SpecimenCell key={label} label={label} wide>
            <div className="w-full">
              <LifetimeLimitNoticeDisplay {...props} />
            </div>
          </SpecimenCell>
        ))}
      </SpecimenPanel>
    </div>
  );
}
