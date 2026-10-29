import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { AgentWritePreparation } from '../../action-support';
import type { AgentActionToolResult } from '../../tools/definition';
import { LABS_EXPERIMENT_ID_PATTERN } from '@canopy/protocol/experiments';
import type { AgentExperimentsPort } from '../../port/experiments-port';
import type { AgentActionReceiptStore } from '../../receipts';
import type { AgentActionLimitsPort } from '../../limits';
import {
  defineAgentActionFamily,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
  type AgentActionDispatchOutput,
} from '../../surface/family';
import {
  agentActionIdempotencyKey,
  agentActionResult,
  agentActionToolResult,
  portErrorResponse,
  runIdempotentWrite,
} from '../../action-support';

export { EXPERIMENT_ACTION_TYPES, experimentActionSchema } from './actions';
import { EXPERIMENT_ACTION_TYPES, experimentActionSchema } from './actions';
export function createExperimentsActionFamily<H>(options: {
  port: AgentExperimentsPort<H>;
  receipts: AgentActionReceiptStore<H>;
  limits: AgentActionLimitsPort | null;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'experiments',
    types: EXPERIMENT_ACTION_TYPES,
    actionSchema: experimentActionSchema,
    supportedTypes: () => EXPERIMENT_ACTION_TYPES,
    catalog: experimentActionCatalog,
    dispatchJsonSchema: experimentDispatchJsonSchema,
    dispatch: async (action, call): Promise<AgentActionDispatchOutput> => {
      try {
        return await runIdempotentWrite({
          receipts: options.receipts,
          limits: options.limits,
          kind: 'experiments.set_enabled',
          call,
          idempotencyKey: agentActionIdempotencyKey(action.type, call, action),
          payload: action,
          prepare: (): Promise<AgentWritePreparation> =>
            Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: async (): Promise<AgentActionToolResult> => {
                const result = await options.port.setEnabled(
                  {
                    experimentId: action.experimentId,
                    enabled: action.enabled,
                  },
                  call,
                );
                return agentActionToolResult(
                  agentActionResult(call, action.type, { ...result }),
                );
              },
            }),
        });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}

export function experimentActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'experiments.set_enabled',
      category: 'settings',
      summary:
        'Store an experiment preference for the current account or local session.',
      fields: [
        {
          name: 'experimentId',
          type: 'string',
          required: true,
          description: 'Registered experiment id, such as early-access.',
        },
        {
          name: 'enabled',
          type: 'boolean',
          required: true,
          description:
            'The stored preference. Availability still controls effective enablement.',
        },
      ],
      example: {
        type: 'experiments.set_enabled',
        experimentId: 'early-access',
        enabled: true,
      },
      keywords: ['labs', 'experiment', 'early access', 'settings'],
      notes: [
        'Results describe state at commit. Replayed receipts are historical and must not be used as a current snapshot.',
      ],
    },
  ];
}

export const experimentDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    experimentId: {
      type: 'string',
      pattern: LABS_EXPERIMENT_ID_PATTERN.source,
    },
    enabled: { type: 'boolean' },
  },
  allOf: [
    {
      if: { properties: { type: { const: 'experiments.set_enabled' } } },
      then: { required: ['experimentId', 'enabled'] },
    },
  ],
};
