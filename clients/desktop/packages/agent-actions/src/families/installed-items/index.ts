import type { AgentWritePreparation } from '../../action-support';
import type { AgentActionToolResult } from '../../tools/definition';
import { z } from 'zod';
import {
  InstalledItemTargetSchema,
  type InstalledItemSnapshot,
  type InstalledItemMutationResult,
  type SetInstalledItemStatusRequest,
  type UninstallInstalledItemRequest,
} from '@canopy/protocol/installed-items';
import type {
  AgentActionCall,
  AgentActionFamily,
  AgentActionFamilyJsonSchema,
} from '../../surface/family';
import { defineAgentActionFamily } from '../../surface/family';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import type { AgentActionReceiptStore } from '../../receipts';
import type { AgentActionLimitsPort } from '../../limits';
import {
  agentActionIdempotencyKey,
  agentActionResult,
  agentActionToolResult,
  portErrorResponse,
  runIdempotentWrite,
} from '../../action-support';

import {
  INSTALLED_ITEM_ACTION_TYPES,
  installedItemActionSchema,
} from './actions';
export {
  INSTALLED_ITEM_ACTION_TYPES,
  installedItemActionSchema,
} from './actions';
export type { InstalledItemAction } from './actions';
export interface AgentInstalledItemsPort<H> {
  listStatus(
    this: void,
    call: AgentActionCall<H>,
  ): Promise<InstalledItemSnapshot>;
  setStatus(
    this: void,
    request: SetInstalledItemStatusRequest,
    call: AgentActionCall<H>,
  ): Promise<InstalledItemMutationResult>;
  uninstall(
    this: void,
    request: UninstallInstalledItemRequest,
    call: AgentActionCall<H>,
  ): Promise<InstalledItemMutationResult>;
}
export function installedItemActionCatalog(): readonly AgentActionCatalogEntry[] {
  return [
    {
      type: 'installed_items.list_status',
      category: 'plugins',
      summary:
        'List installed plugins, skills, MCP configurations and collections, including Disabled items, removal scopes and provider notices.',
      fields: [],
      example: { type: 'installed_items.list_status' },
      keywords: ['installed', 'disabled', 'active', 'available', 'customize'],
    },
    ...(
      ['installed_items.set_status', 'installed_items.uninstall'] as const
    ).map((type) => ({
      type,
      category: 'plugins',
      summary:
        type === 'installed_items.set_status'
          ? 'Set Active, Available or Disabled on an installed item.'
          : 'Uninstall an installed item. Device MCP deletion removes every configuration; account MCP deletion affects the account and removes its sign-in.',
      fields: [
        {
          name: 'target',
          type: 'object',
          required: true,
          description: 'Exact target returned by installed_items.list_status.',
        },
        ...(type === 'installed_items.set_status'
          ? [
              {
                name: 'status',
                type: 'string',
                required: true,
                description: 'active, available or disabled.',
              },
            ]
          : []),
      ],
      example: {
        type,
        target: { kind: 'collection', collectionId: 'collection-id' },
        ...(type === 'installed_items.set_status'
          ? { status: 'available' }
          : {}),
      },
      keywords: ['installed', 'status', 'uninstall', 'disable'],
      notes: [
        'Inspect effective status and per-target errors. A partial outcome is retryable; use a new tool call to reconcile current state. Receipts describe state at commit.',
      ],
    })),
  ];
}
export const installedItemDispatchJsonSchema: AgentActionFamilyJsonSchema = {
  properties: {
    target: z
      .json()
      .parse(
        JSON.parse(JSON.stringify(z.toJSONSchema(InstalledItemTargetSchema))),
      ),
    status: { type: 'string', enum: ['active', 'available', 'disabled'] },
  },
  allOf: [
    {
      if: { properties: { type: { const: 'installed_items.set_status' } } },
      then: { required: ['target', 'status'] },
    },
    {
      if: { properties: { type: { const: 'installed_items.uninstall' } } },
      then: { required: ['target'] },
    },
  ],
};
export function createInstalledItemsActionFamily<H>(options: {
  port: AgentInstalledItemsPort<H>;
  receipts: AgentActionReceiptStore<H>;
  limits: AgentActionLimitsPort | null;
}): AgentActionFamily<H> {
  return defineAgentActionFamily({
    id: 'installed-items',
    types: INSTALLED_ITEM_ACTION_TYPES,
    supportedTypes: () => INSTALLED_ITEM_ACTION_TYPES,
    actionSchema: installedItemActionSchema,
    catalog: installedItemActionCatalog,
    dispatchJsonSchema: installedItemDispatchJsonSchema,
    async dispatch(action, call) {
      try {
        if (action.type === 'installed_items.list_status')
          return agentActionResult(call, action.type, {
            ...(await options.port.listStatus(call)),
          });
        return await runIdempotentWrite({
          receipts: options.receipts,
          limits: options.limits,
          kind: action.type,
          call,
          idempotencyKey: agentActionIdempotencyKey(action.type, call, action),
          payload: action,
          prepare: (): Promise<AgentWritePreparation> =>
            Promise.resolve({
              ok: true,
              parentDepth: 0,
              write: async (): Promise<AgentActionToolResult> => {
                const outcome =
                  action.type === 'installed_items.set_status'
                    ? await options.port.setStatus(
                        { target: action.target, status: action.status },
                        call,
                      )
                    : await options.port.uninstall(
                        { target: action.target },
                        call,
                      );
                const response = agentActionResult(call, action.type, {
                  ...outcome,
                });
                if (!outcome.success && response.ok) {
                  response.ok = false;
                  response.error = {
                    code: 'execution_failed',
                    message:
                      'Installed-item mutation is incomplete. Inspect the effective snapshot and errors.',
                    retryable: outcome.errors.some((error) => error.retryable),
                  };
                }
                return agentActionToolResult(response);
              },
            }),
        });
      } catch (error) {
        return portErrorResponse(call, action.type, error);
      }
    },
  });
}
