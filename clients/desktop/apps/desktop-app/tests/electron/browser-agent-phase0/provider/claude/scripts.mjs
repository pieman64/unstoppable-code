// Scripted conversations (mock `steps`) and prompts for each probe variant.
// The mock keys a scenario by a `[Canopy-C<id>]` marker in user text and picks
// step N from the number of assistant turns already in the request history.
import { validateToolArguments } from '../shared/tool-schemas.mjs';

export const PROBE_PROMPT_VERSION = 'bap0-claude-probe-prompt/1';
/** Short, versioned, browser-only custom system prompt (never the preset). */
export const PROBE_SYSTEM_PROMPT =
  `Probe browser agent (${PROBE_PROMPT_VERSION}). Use only the provided browser tools to work on the current page. ` +
  'This is a synthetic evidence run; answer briefly.';

export const browserToolName = (name) => `mcp__browser__${name}`;

/** Marker key registered with the mock (`Canopy-C<alnum>`). */
export function scenarioKey(label) {
  if (!/^[A-Za-z0-9]{1,24}$/.test(label))
    throw new Error(`Invalid scenario label ${label}`);
  return `Canopy-Cbap0${label}`;
}

export const markerText = (key) => `[${key}]`;

/** The user prompt carries the marker and a tiny synthetic goal. */
export function probeUserPrompt(
  key,
  goal = 'Inspect the current page and report.',
) {
  return `${markerText(key)} ${goal}`;
}

/** Native tool loop for one rotation epoch: observe -> read_text -> scroll -> observe -> record_progress -> finish. */
export const ROTATION_LOOP = Object.freeze([
  'observe',
  'read_text',
  'scroll',
  'observe',
  'record_progress',
  'finish',
]);

const ROTATION_INPUTS = Object.freeze({
  observe: {},
  read_text: { maxCharacters: 2000 },
  scroll: { to: { kind: 'page', direction: 'down', amount: 'page' } },
  record_progress: {
    summary: 'Synthetic progress note.',
    findings: [{ text: 'Synthetic finding.' }],
    nextStep: 'finish',
  },
  finish: { answer: 'Synthetic answer.' },
});

/** Steps for one isolated tool loop. Every input is validated against the derived schema. */
export function rotationSteps(epoch, loop = ROTATION_LOOP) {
  const steps = loop.map((name, index) => {
    const input = ROTATION_INPUTS[name];
    const checked = validateToolArguments(name, input);
    if (!checked.ok)
      throw new Error(
        `Scripted input for ${name} is invalid: ${checked.issues.join('; ')}`,
      );
    return {
      text: `Epoch ${epoch} step ${index + 1}.`,
      toolCalls: [{ name: browserToolName(name), input }],
      stopReason: 'tool_use',
    };
  });
  steps.push({ text: `Epoch ${epoch} done.`, stopReason: 'end_turn' });
  return steps;
}

/** Control: one denied native tool attempt, then a text turn. */
export function controlSteps() {
  return [
    {
      text: 'Control attempt.',
      toolCalls: [
        {
          name: 'Bash',
          input: {
            command: 'echo probe-control',
            description: 'probe control',
          },
        },
      ],
      stopReason: 'tool_use',
    },
    { text: 'Control turn complete.', stopReason: 'end_turn' },
  ];
}

/** Isolated B/C: one browser tool, one unavailable native tool attempt, then text. */
export function isolatedSteps() {
  const observe = validateToolArguments('observe', {});
  if (!observe.ok) throw new Error('observe {} must validate');
  return [
    {
      text: 'Isolated step 1.',
      toolCalls: [{ name: browserToolName('observe'), input: {} }],
      stopReason: 'tool_use',
    },
    {
      text: 'Isolated step 2.',
      toolCalls: [
        {
          name: 'Bash',
          input: {
            command: 'echo probe-isolated',
            description: 'probe isolated',
          },
        },
      ],
      stopReason: 'tool_use',
    },
    { text: 'Isolated turn complete.', stopReason: 'end_turn' },
  ];
}

/** Launch failure: the first model request is answered with an HTTP 400. */
export function launchFailureSteps() {
  return [{ error: { status: 400, message: 'Probe induced launch failure.' } }];
}

/** Budget-hook experiment: a long observe loop the host should stop early. */
export function budgetHookSteps(observations = 6) {
  const steps = [];
  for (let index = 0; index < observations; index += 1)
    steps.push({
      text: `Budget step ${index + 1}.`,
      toolCalls: [{ name: browserToolName('observe'), input: {} }],
      stopReason: 'tool_use',
    });
  steps.push({ text: 'Budget loop done.', stopReason: 'end_turn' });
  return steps;
}
