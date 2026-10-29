// Scripted conversations and host tool execution for the Codex probe.
// The mock resolves the next scripted step from the request history
// (`openAiStepCursor: 'completed-scenario-tool-calls'`), so a turn is a list of
// steps keyed by a `[Canopy-C...]` marker in the user text.
import { randomBytes } from 'node:crypto';
import {
  BROWSER_AGENT_TOOL_NAMES,
  validateToolArguments,
} from '../shared/tool-schemas.mjs';
import {
  buildSyntheticObservation,
  observationToolText,
  pageSentinel,
} from '../shared/synthetic-page.mjs';

/** The tool loop every browser epoch runs, in order. */
export const EPOCH_TOOL_SCRIPT = Object.freeze([
  { tool: 'observe', input: {} },
  { tool: 'read_text', input: { maxCharacters: 6000 } },
  { tool: 'scroll', input: { to: { kind: 'page', direction: 'down' } } },
  { tool: 'observe', input: {} },
  {
    tool: 'record_progress',
    input: {
      summary: 'Probe progress receipt.',
      findings: [{ text: 'synthetic finding' }],
    },
  },
  {
    tool: 'finish',
    input: {
      answer: 'Probe finished.',
      findings: [{ text: 'synthetic finding' }],
    },
  },
]);

export function newNonce() {
  return randomBytes(6).toString('hex');
}

/** Marker key; also the registerScenario key. */
export function markerFor(kind, nonce = newNonce()) {
  if (!/^[a-z0-9-]{1,24}$/.test(kind))
    throw new Error(`invalid marker kind ${kind}`);
  return `Canopy-Cbap0-${kind}-${nonce}`;
}

function scenarioOf(steps) {
  return { llm: { openAiStepCursor: 'completed-scenario-tool-calls', steps } };
}

/** One scripted native tool loop, then a closing text step. */
export function browserLoopScenario() {
  return scenarioOf([
    ...EPOCH_TOOL_SCRIPT.map(({ tool, input }) => ({
      toolCalls: [{ name: tool, input }],
      stopReason: 'tool_use',
    })),
    { text: 'Probe loop complete.', stopReason: 'end_turn' },
  ]);
}

/** Coding positive control: one text turn. */
export function codingScenario() {
  return scenarioOf([
    { text: 'Coding control complete.', stopReason: 'end_turn' },
  ]);
}

/** Induced failure: the first model response fails (non-retryable usage-limit shape). */
export function failureScenario() {
  return scenarioOf([{ error: 'usage_limit' }]);
}

/**
 * Host tool executor for one epoch. Validates arguments exactly as a gateway
 * would, returns the synthetic observation for `observe`, a 6,000-character
 * text page for `read_text` and small JSON receipts otherwise.
 *
 * @param {{ epoch: number, nonce: string, onCall?: (entry: object) => void | Promise<void> }} options
 */
export function createEpochToolHost({ epoch, nonce, onCall }) {
  const sentinel = pageSentinel(epoch, nonce);
  const allowed = new Set(BROWSER_AGENT_TOOL_NAMES);
  const calls = [];
  let observeCount = 0;
  return {
    sentinel,
    calls,
    async execute(call) {
      const startedAt = performance.now();
      const step = calls.length;
      let text;
      let success = true;
      if (!allowed.has(call.tool) || call.namespace) {
        success = false;
        text = JSON.stringify({
          ok: false,
          error: 'unknown_tool',
          tool: call.tool,
        });
      } else {
        const validation = validateToolArguments(
          call.tool,
          call.arguments ?? {},
        );
        if (!validation.ok) {
          success = false;
          text = JSON.stringify({
            ok: false,
            error: 'invalid_arguments',
            issues: validation.issues,
          });
        } else if (call.tool === 'observe') {
          observeCount += 1;
          text = observationToolText(
            buildSyntheticObservation({ sentinel, epoch, step: observeCount }),
          );
        } else if (call.tool === 'read_text') {
          text = JSON.stringify({
            ok: true,
            text: `Page ${sentinel} text ${'lorem ipsum dolor sit amet '.repeat(300)}`.slice(
              0,
              6000,
            ),
            truncated: true,
          });
        } else {
          text = JSON.stringify({ ok: true, tool: call.tool, step });
        }
      }
      const entry = {
        step,
        tool: call.tool,
        argumentBytes: Buffer.byteLength(JSON.stringify(call.arguments ?? {})),
        resultBytes: Buffer.byteLength(text),
        success,
        ms: performance.now() - startedAt,
        at: Date.now(),
      };
      calls.push(entry);
      if (onCall) await onCall(entry);
      return { success, contentItems: [{ type: 'inputText', text }] };
    },
  };
}
