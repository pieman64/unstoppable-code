import { z } from 'zod';
import type { AgentActionDescriptionCapabilities } from './descriptions';
import type { AgentJsonSchema } from './definition';

const PRIVATE_FOLLOW_UP_DESCRIPTION =
  'The follow-up instruction delivered privately to the independent forked chat.';
const VISIBLE_FOLLOW_UP_DESCRIPTION =
  'The follow-up instruction posted to the independent forked chat as its first visible message.';

export const startSplitAgentInputSchema = z
  .object({
    followUpInstruction: z
      .string()
      .trim()
      .min(1)
      .max(100000)
      .describe(PRIVATE_FOLLOW_UP_DESCRIPTION),
  })
  .strict();

export type StartSplitAgentInput = z.infer<typeof startSplitAgentInputSchema>;

function splitAgentJsonSchema(description: string): AgentJsonSchema {
  return {
    type: 'object',
    properties: {
      followUpInstruction: {
        type: 'string',
        minLength: 1,
        maxLength: 100000,
        description,
      },
    },
    required: ['followUpInstruction'],
    additionalProperties: false,
  };
}

export const START_SPLIT_AGENT_JSON_SCHEMA: AgentJsonSchema =
  splitAgentJsonSchema(PRIVATE_FOLLOW_UP_DESCRIPTION);

/** The split-agent input schema, worded for how the host delivers follow-ups. */
export function startSplitAgentJsonSchema(
  capabilities?: AgentActionDescriptionCapabilities,
): AgentJsonSchema {
  return capabilities?.hiddenInstructions === false
    ? splitAgentJsonSchema(VISIBLE_FOLLOW_UP_DESCRIPTION)
    : START_SPLIT_AGENT_JSON_SCHEMA;
}
