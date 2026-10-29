import { SCRIPT_PREFERENCES_ACTION_TYPES } from './actions';
export { SCRIPT_PREFERENCES_ACTION_TYPES } from './actions';
import { z } from 'zod';
import type { AgentActionCatalogEntry } from '../../catalog/types';
import { agentActionResult, portErrorResponse } from '../../action-support';
import type { AgentActionResponse, AgentJson } from '../../response';
import type {
  AgentActionCall,
  AgentActionFamilyJsonSchema,
} from '../../surface/family';

const target = {
  workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  inWorktreeId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
};
const id = z.string().min(1).max(4096);
/** Human consent and execution are deliberately absent. */
export const scriptPreferencesActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('script_actions.list'), ...target }),
  z.strictObject({ type: z.literal('script_actions.open_review'), ...target }),
  z.strictObject({ type: z.literal('script_actions.rescan'), ...target }),
  z.strictObject({
    type: z.literal('script_actions.set_pin'),
    ...target,
    id,
    pinned: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('script_actions.set_shortcut'),
    ...target,
    id,
    accelerator: z.string().min(1).max(100).nullable(),
  }),
]);
export type ScriptPreferencesAction = z.output<
  typeof scriptPreferencesActionSchema
>;
export interface ScriptPreferencesPort<H> {
  execute(
    action: ScriptPreferencesAction,
    call: AgentActionCall<H>,
  ): Promise<AgentJson>;
}
export async function dispatchScriptPreferencesAction<H>(
  action: ScriptPreferencesAction,
  port: ScriptPreferencesPort<H>,
  call: AgentActionCall<H>,
): Promise<AgentActionResponse> {
  try {
    return agentActionResult(
      call,
      action.type,
      await port.execute(action, call),
    );
  } catch (error) {
    return portErrorResponse(call, action.type, error);
  }
}
const context = { workspaceId: 'workspace-id', inWorktreeId: 'worktree-id' };
const fields = [
  {
    name: 'workspaceId',
    type: 'string',
    required: true,
    description: 'Explicit code project to inspect.',
  },
  {
    name: 'inWorktreeId',
    type: 'string',
    required: true,
    description: 'Worktree belonging to that project.',
  },
];
export const scriptPreferencesActionCatalog: readonly AgentActionCatalogEntry<
  ScriptPreferencesAction['type'],
  ScriptPreferencesAction
>[] = [
  {
    type: 'script_actions.list',
    category: 'settings',
    summary:
      'List reviewed repository scripts and their statuses and desktop preferences, without command contents.',
    fields,
    example: { type: 'script_actions.list', ...context },
    keywords: [
      'detected scripts',
      'aliases',
      'script approval',
      'pins',
      'shortcuts',
    ],
  },
  {
    type: 'script_actions.open_review',
    category: 'settings',
    summary:
      'Open script review so the user can approve, dismiss or restore scripts and opt in to shell scanning.',
    fields,
    example: { type: 'script_actions.open_review', ...context },
    keywords: ['detected scripts', 'review scripts', 'shell aliases'],
  },
  {
    type: 'script_actions.rescan',
    category: 'settings',
    summary:
      'Refresh repository script detection. Personal shell files are read only after the user has opted in.',
    fields,
    example: { type: 'script_actions.rescan', ...context },
    keywords: ['rescan scripts', 'detect scripts'],
  },
  {
    type: 'script_actions.set_pin',
    category: 'settings',
    summary:
      'Change the desktop top-bar pin preference for an already approved script.',
    fields: [
      ...fields,
      {
        name: 'id',
        type: 'string',
        required: true,
        description: 'Exact action identity from script_actions.list.',
      },
      {
        name: 'pinned',
        type: 'boolean',
        required: true,
        description: 'Whether the approved script is pinned.',
      },
    ],
    example: {
      type: 'script_actions.set_pin',
      ...context,
      id: 'action-id',
      pinned: true,
    },
    keywords: ['pin script', 'unpin script', 'top bar'],
  },
  {
    type: 'script_actions.set_shortcut',
    category: 'settings',
    summary:
      'Change a desktop shortcut for an already approved script; conflicts are rejected by the executing host.',
    fields: [
      ...fields,
      {
        name: 'id',
        type: 'string',
        required: true,
        description: 'Exact action identity from script_actions.list.',
      },
      {
        name: 'accelerator',
        type: 'string | null',
        required: true,
        description: 'Shortcut chord, or null to clear a retained preference.',
      },
    ],
    example: {
      type: 'script_actions.set_shortcut',
      ...context,
      id: 'action-id',
      accelerator: null,
    },
    keywords: ['script shortcut', 'key binding'],
  },
];
export const scriptPreferencesDispatchJsonSchema: AgentActionFamilyJsonSchema =
  {
    properties: {
      workspaceId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' },
      inWorktreeId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' },
      id: { type: 'string', minLength: 1, maxLength: 4096 },
      pinned: { type: 'boolean' },
      accelerator: { type: ['string', 'null'], minLength: 1, maxLength: 100 },
    },
    allOf: SCRIPT_PREFERENCES_ACTION_TYPES.map((type) => ({
      if: { properties: { type: { const: type } }, required: ['type'] },
      then: {
        required: [
          'workspaceId',
          'inWorktreeId',
          ...(type === 'script_actions.set_pin'
            ? ['id', 'pinned']
            : type === 'script_actions.set_shortcut'
              ? ['id', 'accelerator']
              : []),
        ],
      },
    })),
  };
