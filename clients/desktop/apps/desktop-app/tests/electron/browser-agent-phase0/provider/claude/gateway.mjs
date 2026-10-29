// The in-process browser gateway: the 22 derived tools as an SDK MCP server.
// Handlers validate arguments with the portable schema and return synthetic
// observations carrying a per-epoch page sentinel.
import { randomBytes } from 'node:crypto';
import {
  buildSyntheticObservation,
  observationToolText,
  pageSentinel,
} from '../shared/synthetic-page.mjs';
import {
  deriveBrowserToolSchemas,
  toolArgumentSchema,
  validateToolArguments,
} from '../shared/tool-schemas.mjs';
import { browserToolName } from './scripts.mjs';

/** Tools whose result is a full-size observation. */
export const OBSERVATION_TOOLS = Object.freeze(
  new Set(['observe', 'read_text', 'scroll', 'search_text']),
);

export function newSentinel(epoch) {
  return pageSentinel(epoch, randomBytes(6).toString('hex'));
}

/**
 * @param {{ createSdkMcpServer: Function, tool: Function }} sdk
 * @param {{ epoch: number, sentinel: string, now?: () => number }} options
 */
export function createBrowserGateway(
  sdk,
  { epoch, sentinel, now = () => Date.now() },
) {
  const events = [];
  let step = 0;
  const derived = deriveBrowserToolSchemas();
  const tools = derived.map(({ name, description }) =>
    sdk.tool(
      name,
      description,
      toolArgumentSchema(name).shape,
      async (args) => {
        const checked = validateToolArguments(name, args);
        if (!checked.ok) {
          events.push({ tool: name, at: now(), valid: false });
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Invalid arguments: ${checked.issues.join('; ')}`,
              },
            ],
          };
        }
        let text;
        if (OBSERVATION_TOOLS.has(name)) {
          step += 1;
          text = observationToolText(
            buildSyntheticObservation({ sentinel, epoch, step }),
          );
        } else {
          text = JSON.stringify({ ok: true, tool: name });
        }
        events.push({
          tool: name,
          at: now(),
          valid: true,
          resultBytes: Buffer.byteLength(text),
          step,
        });
        return { content: [{ type: 'text', text }] };
      },
    ),
  );
  const server = sdk.createSdkMcpServer({
    name: 'browser',
    version: '0.0.0-probe',
    alwaysLoad: true,
    tools,
  });
  return {
    server,
    events: () => events.map((event) => ({ ...event })),
    toolNames: derived.map(({ name }) => name),
    allowedTools: derived.map(({ name }) => browserToolName(name)),
  };
}
