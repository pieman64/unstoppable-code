import { z } from 'zod';
import {
  capabilityRepairSubjectSchema,
  capabilityRepairAnalysisContextSchema,
  capabilityPackageAnalysisResultSchema,
  failedCapabilityPackageAnalysis,
} from '@canopy/protocol/capability-package-repair';
import type { AgentCapabilityPackagePort } from '../../port/capability-package-port';
import {
  defineAgentActionFamily,
  type AgentActionFamily,
  type AgentActionFamilyJsonSchema,
} from '../../surface/family';
import type { AgentActionCatalogEntry } from '../../catalog/types';

import {
  CAPABILITY_PACKAGE_ACTION_TYPES,
  capabilityPackageAnalyzeSchema,
} from './actions';
export {
  CAPABILITY_PACKAGE_ACTION_TYPES,
  capabilityPackageAnalyzeSchema,
} from './actions';

export function capabilityPackageActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'capability_package.analyze',
      category: 'sharing',
      summary:
        'Check share dependencies on the current saved skill or pipeline without publishing or editing it.',
      fields: [
        {
          name: 'subject',
          type: 'object',
          required: true,
          description:
            'Exact custom skill, user pipeline, or project pipeline identity. Project paths are repository-relative and must belong to this chat’s worktree.',
        },
        {
          name: 'context',
          type: 'object',
          required: false,
          description:
            'The share dialog’s dismissed invocations and optional calling-worktree analysis context.',
        },
      ],
      example: {
        type: 'capability_package.analyze',
        subject: {
          kind: 'skill',
          sourceId: 'custom:app',
          skillName: 'my-skill',
        },
      },
      keywords: [
        'share',
        'dependencies',
        'skill',
        'pipeline',
        'repair',
        'recheck',
      ],
      notes: [
        'Inspect current content before repair. A failed analysis is never ready. Truncated results omit details; recheck before deciding on a repair.',
        'Read-only analysis. This action does not publish or open a share dialog.',
      ],
    },
  ];
}
export const capabilityPackageDispatchJsonSchema: AgentActionFamilyJsonSchema =
  {
    properties: {
      subject: z
        .json()
        .parse(
          JSON.parse(
            JSON.stringify(z.toJSONSchema(capabilityRepairSubjectSchema)),
          ),
        ),
      context: z
        .json()
        .parse(
          JSON.parse(
            JSON.stringify(
              z.toJSONSchema(capabilityRepairAnalysisContextSchema),
            ),
          ),
        ),
    },
    allOf: [
      {
        if: {
          properties: { type: { const: 'capability_package.analyze' } },
          required: ['type'],
        },
        then: { required: ['subject'] },
      },
    ],
  };

export function createCapabilityPackageActionFamily<H>(options: {
  port: AgentCapabilityPackagePort<H>;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'capability-package',
    types: CAPABILITY_PACKAGE_ACTION_TYPES,
    supportedTypes: () => CAPABILITY_PACKAGE_ACTION_TYPES,
    actionSchema: capabilityPackageAnalyzeSchema,
    catalog: capabilityPackageActionCatalog,
    dispatchJsonSchema: capabilityPackageDispatchJsonSchema,
    dispatch: async (action, call) => {
      try {
        const { agentArtifacts, ...analysis } = await options.port.analyze(
          {
            subject: action.subject,
            ...(action.context ? { context: action.context } : {}),
          },
          call,
        );
        const result = capabilityPackageAnalysisResultSchema.parse(analysis);
        return {
          requestId: call.toolUseId ?? '',
          ok: result.state !== 'failed',
          result: {
            ...result,
            ...(result.state !== 'failed' && agentArtifacts?.length
              ? { agentArtifacts }
              : {}),
          },
          ...(result.state === 'failed'
            ? {
                error: {
                  code: 'execution_failed',
                  message:
                    result.error ?? 'Could not check share dependencies.',
                },
              }
            : {}),
        };
      } catch (error) {
        const result = failedCapabilityPackageAnalysis(error);
        return {
          requestId: call.toolUseId ?? '',
          ok: false,
          result,
          error: {
            code: 'execution_failed',
            message: result.error ?? 'Could not check share dependencies.',
          },
        };
      }
    },
  });
}
