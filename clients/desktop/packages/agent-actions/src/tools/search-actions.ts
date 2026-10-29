import { z } from 'zod';
import type { AgentJsonSchema } from './definition';
import {
  agentActionCategories,
  listInProse,
  workspaceScopedActions,
  type AgentActionDescriptionOffer,
} from './descriptions';

export const searchActionsInputSchema = z.object({
  query: z.string().optional(),
  category: z.string().optional(),
  actionType: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export type SearchActionsInput = z.infer<typeof searchActionsInputSchema>;

export const SEARCH_ACTIONS_JSON_SCHEMA: AgentJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Search terms such as "pipeline run", "execution details", or "cancel pipeline".',
    },
    category: {
      type: 'string',
      description:
        'Optional category filter. Available categories may include "skills", "pipeline", "worktree", "automations", "tracked-plan", "hook", and "browser" depending on the chat surface. Omit to search all categories.',
    },
    actionType: {
      type: 'string',
      description:
        'Optional exact action type, such as skills.list, skills.create_custom, pipeline.list, pipeline.get, pipeline.create, pipeline.run, pipeline.execution_list, pipeline.execution_get, pipeline.execution_cancel, pipeline.execution_resume, pipeline.execution_retry_matrix_job, pipeline.execution_cancel_matrix_variant, pipeline.execution_retry, pipeline.execution_chain, automation.list, automation.create, worktree.get_settings, worktree.list_scripts, worktree.run_script, tracked-plan.import, hook.pause, hook.resume, browser.open, browser.navigate, browser.focus, browser.wait_for, browser.input_snapshot, browser.screenshot, or browser.inspect.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
      description: 'Maximum number of matching actions to return.',
    },
  },
  additionalProperties: false,
};

/**
 * The SearchActions input schema for a host's offer: a host whose reach is
 * the current workspace names only its own categories and action types;
 * any other host keeps {@link SEARCH_ACTIONS_JSON_SCHEMA}.
 */
export function buildSearchActionsJsonSchema(
  offer?: AgentActionDescriptionOffer,
): AgentJsonSchema {
  const actions = workspaceScopedActions(offer);
  if (!actions) return SEARCH_ACTIONS_JSON_SCHEMA;
  const categories = agentActionCategories(actions).map(
    (category) => `"${category}"`,
  );
  const types = actions.map((action) => action.type);
  return {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search terms describing the action you need.',
      },
      category: {
        type: 'string',
        description: `Optional category filter: ${listInProse(categories, 'or')}. Omit to search all categories.`,
      },
      actionType: {
        type: 'string',
        description: `Optional exact action type: ${listInProse(types, 'or')}.`,
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum number of matching actions to return.',
      },
    },
    additionalProperties: false,
  };
}
