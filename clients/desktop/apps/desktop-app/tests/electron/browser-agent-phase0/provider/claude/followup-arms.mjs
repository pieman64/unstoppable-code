// October 2 follow-up arm catalog and scripted tool loops. Pure data: nothing
// here starts a provider. `followup.mjs` executes the arms; tests pin the
// structure so neither memory control can silently become inert.
import { CONTEXT_CHECKPOINT_TOKENS } from '../shared/followup-policy.mjs';
import { validateToolArguments } from '../shared/tool-schemas.mjs';
import {
  controlOptions,
  isolatedOptions,
  productionEquivalentOptions,
  safeModeOptions,
  targetedControlOptions,
  assertNoBareMode,
} from './launch-options.mjs';
import {
  FOLLOWUP_EXTRA_ENV_NAMES,
  TARGETED_CONTROL_ENV,
} from './probe-env.mjs';
import { browserToolName, controlSteps } from './scripts.mjs';

/**
 * Roles:
 *  - `positive-control`: unrestricted launch with the memory flag removed; must show the fixtures live.
 *  - `flag-only`: unrestricted launch with the production memory flag kept (the flag's effect alone).
 *  - `options-only`: isolated launch with the memory flag removed (the SDK options' effect alone).
 *  - `candidate`: an isolated production-shaped launch (memory flag kept).
 *  - `auth-init` / `auth-loopback`: synthetic OAuth credential-shape arms.
 *  - `context`: scripted usage plumbing; not calibration.
 */
export const FOLLOWUP_ARMS = Object.freeze([
  {
    id: 'U-mem',
    label: 'unrestricted positive control, memory flag removed',
    role: 'positive-control',
    options: 'unrestricted',
    memoryFlag: 'removed',
    credential: 'api-key',
    script: 'control',
    isolated: false,
    timeoutMs: 35_000,
  },
  {
    id: 'I-prod',
    label: 'production-equivalent isolated launch (DISABLE_AUTO_MEMORY=1 kept)',
    role: 'candidate',
    options: 'production',
    memoryFlag: 'kept',
    credential: 'api-key',
    script: 'loop',
    isolated: true,
    timeoutMs: 40_000,
  },
  {
    id: 'I-safe',
    label: 'isolated + --safe-mode with the explicit in-process browser MCP',
    role: 'candidate',
    options: 'safe-mode',
    memoryFlag: 'kept',
    credential: 'api-key',
    script: 'loop',
    isolated: true,
    timeoutMs: 40_000,
  },
  {
    id: 'I-targeted',
    label: 'isolated + targeted controls (07 section 11 table)',
    role: 'candidate',
    options: 'targeted',
    memoryFlag: 'kept',
    extraEnv: TARGETED_CONTROL_ENV,
    credential: 'api-key',
    script: 'loop',
    isolated: true,
    timeoutMs: 40_000,
  },
  {
    id: 'U-flag',
    label:
      'unrestricted launch, production memory flag kept (flag effect alone)',
    role: 'flag-only',
    options: 'unrestricted',
    memoryFlag: 'kept',
    credential: 'api-key',
    script: 'control',
    isolated: false,
    timeoutMs: 35_000,
  },
  {
    id: 'I-removed',
    label: 'isolated launch, memory flag removed (options effect alone)',
    role: 'options-only',
    options: 'flag-removed',
    memoryFlag: 'removed',
    credential: 'api-key',
    script: 'loop',
    isolated: true,
    timeoutMs: 40_000,
  },
  {
    id: 'I-context',
    label:
      'production-equivalent isolated launch with scripted usage across the checkpoint',
    role: 'context',
    options: 'production',
    memoryFlag: 'kept',
    credential: 'api-key',
    script: 'context',
    isolated: true,
    timeoutMs: 45_000,
    contextUsage: { afterAssistantMessages: 3 },
  },
  {
    id: 'O-init',
    label:
      'production-shaped synthetic OAuth (oauthToken only), init metadata only',
    role: 'auth-init',
    options: 'production',
    memoryFlag: 'kept',
    credential: 'oauth-init',
    script: 'none',
    isolated: true,
    initOnly: true,
    timeoutMs: 25_000,
  },
  {
    id: 'O-loop',
    label:
      'synthetic OAuth + loopback base URL (NON-production transport delta)',
    role: 'auth-loopback',
    options: 'production',
    memoryFlag: 'kept',
    credential: 'oauth-loopback',
    script: 'loop',
    isolated: true,
    timeoutMs: 40_000,
  },
  {
    id: 'O-safe-init',
    label: 'safe-mode synthetic OAuth, production-shaped init metadata only',
    role: 'auth-init',
    options: 'safe-mode',
    memoryFlag: 'kept',
    credential: 'oauth-init',
    script: 'none',
    isolated: true,
    initOnly: true,
    timeoutMs: 25_000,
  },
  {
    id: 'O-safe-loop',
    label:
      'safe-mode synthetic OAuth + loopback (NON-production transport delta)',
    role: 'auth-loopback',
    options: 'safe-mode',
    memoryFlag: 'kept',
    credential: 'oauth-loopback',
    script: 'loop',
    isolated: true,
    timeoutMs: 40_000,
  },
]);

export const ARM_BY_ID = Object.freeze(
  Object.fromEntries(FOLLOWUP_ARMS.map((arm) => [arm.id, arm])),
);

/** Arms that start a loopback model and drive a scripted conversation. */
export const TOOL_LOOP_ARM_IDS = Object.freeze(
  FOLLOWUP_ARMS.filter(
    (arm) => arm.script === 'loop' || arm.script === 'context',
  ).map((arm) => arm.id),
);

/** observe -> action (click) -> observe -> finish. Inputs are validated against the derived schema. */
export const BROWSER_LOOP = Object.freeze([
  ['observe', {}],
  ['click', { target: { observationId: 'obs-probe-1', ref: 'e1' } }],
  ['observe', {}],
  ['finish', { answer: 'Synthetic answer.' }],
]);

function loopSteps(usageFor = () => undefined) {
  const steps = BROWSER_LOOP.map(([name, input], index) => {
    const checked = validateToolArguments(name, input);
    if (!checked.ok)
      throw new Error(
        `Scripted ${name} input invalid: ${checked.issues.join('; ')}`,
      );
    const usage = usageFor(index);
    return {
      text: `Follow-up step ${index + 1}.`,
      toolCalls: [{ name: browserToolName(name), input }],
      stopReason: 'tool_use',
      ...(usage ? { usage } : {}),
    };
  });
  steps.push({ text: 'Follow-up done.', stopReason: 'end_turn' });
  return steps;
}

/** Plain scripted loop: no scripted usage beyond the mock defaults. */
export function followupLoopSteps() {
  return loopSteps();
}

/**
 * Scripted usage that rises across the 125,000-token checkpoint. This only
 * exercises usage plumbing: the numbers are authored here, not measured.
 */
export function contextLoopSteps(checkpoint = CONTEXT_CHECKPOINT_TOKENS) {
  const inputTokens = [
    Math.floor(checkpoint * 0.4),
    Math.floor(checkpoint * 0.8),
    checkpoint + 1_000,
    checkpoint + 2_000,
    checkpoint + 3_000,
  ];
  return loopSteps((index) => ({
    inputTokens: inputTokens[index],
    outputTokens: 200,
  }));
}

/** SDK options for one arm. Throws if an OAuth arm would select bare/SIMPLE mode. */
export function armOptions(arm, { gateway, denials, env = {} }) {
  let options;
  switch (arm.options) {
    case 'unrestricted':
      options = controlOptions({ denials });
      break;
    case 'production':
      options = productionEquivalentOptions({ gateway, denials });
      break;
    case 'flag-removed':
      options = isolatedOptions({ gateway, denials });
      break;
    case 'targeted':
      options = targetedControlOptions({ gateway, denials });
      break;
    case 'safe-mode':
      options = safeModeOptions({ gateway, denials });
      break;
    default:
      throw new Error(`Unknown option kind ${arm.options}`);
  }
  assertNoBareMode(options, env);
  return options;
}

/** `buildProviderEnvironment` parameters (minus the shared seams/layout) for one arm. */
export function armEnvironmentParams(arm) {
  return {
    keepAutoMemoryDisable: arm.memoryFlag === 'kept',
    credentialMode: arm.credential,
    extraEnv: arm.extraEnv ?? {},
    disableClaudeMds: false,
  };
}

/** `verifyProviderEnvironment` expectations for one arm. */
export function armVerifyParams(arm) {
  const extraEnv = arm.extraEnv ?? {};
  return {
    credentialMode: arm.credential,
    expectAutoMemoryDisabled: arm.memoryFlag === 'kept',
    expectDisableMds: extraEnv.CLAUDE_CODE_DISABLE_CLAUDE_MDS === '1',
    extraAllowedNames: FOLLOWUP_EXTRA_ENV_NAMES,
    expectedExtraEnv: extraEnv,
  };
}

/** Scripted mock steps for one arm (`null`: no model conversation is registered). */
export function armSteps(arm) {
  switch (arm.script) {
    case 'control':
      return controlSteps();
    case 'loop':
      return followupLoopSteps();
    case 'context':
      return contextLoopSteps();
    case 'none':
      return null;
    default:
      throw new Error(`Unknown script ${arm.script}`);
  }
}

/** Scripted input-token numbers per step, for labeling plumbing evidence. */
export function scriptedInputTokens(arm) {
  const steps = armSteps(arm) ?? [];
  return steps.map((step) => step.usage?.inputTokens ?? null);
}
