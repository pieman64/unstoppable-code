import type { AgentJson } from '../response';

/** A JSON Schema object advertised as a tool's input schema. */
export type AgentJsonSchema = { [key: string]: AgentJson };

/** One model-visible tool: its canonical key, name, description, and schema. */
export interface AgentActionToolDefinition<TKey extends string = string> {
  key: TKey;
  name: string;
  description: string;
  inputSchema: AgentJsonSchema;
}

/** Text result of an agent action tool call, ready for any provider. */
export interface AgentActionToolResult {
  text: string;
  isError?: boolean;
  imageDataUrl?: string;
}

/** The standard invalid-arguments tool result. */
export function invalidAgentActionArguments(
  toolName: string,
  details?: readonly string[],
): AgentActionToolResult {
  return {
    text: [
      `Invalid arguments for ${toolName}.`,
      ...(details?.map((detail) => `- ${detail}`) ?? []),
    ].join('\n'),
    isError: true,
  };
}
