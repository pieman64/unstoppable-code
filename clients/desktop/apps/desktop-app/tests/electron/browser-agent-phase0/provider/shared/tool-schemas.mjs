// Native tool schemas derived from the portable contract. The input schemas
// are exact (`z.toJSONSchema` over BROWSER_AGENT_TOOL_ARGUMENTS); descriptions
// are clearly labelled probe placeholders, not production tool copy.
import { z } from 'zod';
import {
  BROWSER_AGENT_TOOL_ARGUMENTS,
  BROWSER_AGENT_TOOL_NAMES,
} from '@canopy/protocol/delegation/browser-agent';

export const PROBE_TOOL_DESCRIPTION_NOTE =
  'Probe placeholder description; production copy is not defined by S0.1.';

/** Input JSON Schema for one closed browser-agent tool. */
export function toolInputJsonSchema(name) {
  const schema = BROWSER_AGENT_TOOL_ARGUMENTS[name];
  if (!schema) throw new Error(`Unknown browser-agent tool ${name}`);
  // Refinements (URL syntax, blank text) are not representable in JSON
  // Schema; the host still validates arguments with the zod schema.
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}

/**
 * Every closed tool with its derived schema and serialized size.
 *
 * @returns {{ name: string, description: string, inputSchema: object, schemaBytes: number, definitionBytes: number }[]}
 */
export function deriveBrowserToolSchemas() {
  return BROWSER_AGENT_TOOL_NAMES.map((name) => {
    const inputSchema = toolInputJsonSchema(name);
    const description = `Browser agent tool "${name}". ${PROBE_TOOL_DESCRIPTION_NOTE}`;
    const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema));
    const definitionBytes = Buffer.byteLength(
      JSON.stringify({ name, description, inputSchema }),
    );
    return { name, description, inputSchema, schemaBytes, definitionBytes };
  });
}

/** The zod object for a tool (for SDK helpers that take zod shapes). */
export function toolArgumentSchema(name) {
  const schema = BROWSER_AGENT_TOOL_ARGUMENTS[name];
  if (!schema) throw new Error(`Unknown browser-agent tool ${name}`);
  return schema;
}

/** Validate tool arguments the way the host gateway would. */
export function validateToolArguments(name, input) {
  const result = toolArgumentSchema(name).safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        issues: result.error.issues.map((issue) => issue.message).slice(0, 5),
      };
}

/** Size summary for the report (bytes, not tokens). */
export function schemaOverheadSummary(tools = deriveBrowserToolSchemas()) {
  return {
    toolCount: tools.length,
    totalSchemaBytes: tools.reduce((sum, tool) => sum + tool.schemaBytes, 0),
    totalDefinitionBytes: tools.reduce(
      (sum, tool) => sum + tool.definitionBytes,
      0,
    ),
    perTool: Object.fromEntries(
      tools.map((tool) => [tool.name, tool.definitionBytes]),
    ),
    note: 'Bytes of the probe tool definitions as serialized JSON; provider wire encodings add their own framing, measured from captured requests.',
  };
}

export { BROWSER_AGENT_TOOL_NAMES };
