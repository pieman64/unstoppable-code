import {
  MODEL_LIBRARY_PROTOCOL_HEADER,
  MODEL_LIBRARY_PROTOCOL_VERSION,
} from '@canopy/protocol/models';
import {
  AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER,
  AI_CREDITS_ORG_PROJECT_HEADER,
  AI_CREDITS_WORK_OWNER_HEADER,
} from '@canopy/protocol/llm-gateway';
import { isSyntacticallyValidModelId } from '../../lib/model-id';
import { toOpenCodeModelId } from '../../lib/opencode-models';
import {
  openCodeCapabilityDigest,
  type OpenCodeInferenceSelection,
  type OpenCodeCapabilityBinding,
} from './capability-snapshot';

const ATTRIBUTION_HEADERS = new Set<string>([
  MODEL_LIBRARY_PROTOCOL_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKSPACE_HEADER,
  AI_CREDITS_ATTRIBUTION_WORKTREE_HEADER,
  AI_CREDITS_ORG_PROJECT_HEADER,
  AI_CREDITS_WORK_OWNER_HEADER,
]);

/** Trusted host input. The host retains credentials, owner policy and lease disposal. */
export interface OpenCodeInferenceRoute {
  /** Hash of the host's stable funding/account/owner/endpoint authority. */
  bindingKey: string;
  /** Host-validated logical selection and funding identity for explicit model changes. */
  selection?: { modelId: string; fundingKey: string };
  protocol: 'anthropic-messages' | 'openai-responses';
  /** Existing local gateway broker lease. Never an upstream provider URL. */
  baseUrl: string;
  model: {
    id: string;
    contextWindow: number;
    outputLimit: number;
    supportsVision: boolean;
  };
  /** App attribution only. Authentication remains in the broker. */
  headers?: Readonly<Record<string, string>>;
}

export function prepareOpenCodeInferenceRoute(route: OpenCodeInferenceRoute): {
  route: OpenCodeInferenceRoute;
  rawModelId: string;
  config: Record<string, unknown>;
  identityDigest: string;
  selection?: OpenCodeInferenceSelection;
  settingsDigest: string;
} {
  const invalid = (): never => {
    throw new Error(
      'OpenCode inference route is unavailable. Select the model again.',
    );
  };
  if (
    typeof route.bindingKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(route.bindingKey) ||
    (route.protocol !== 'anthropic-messages' &&
      route.protocol !== 'openai-responses')
  )
    invalid();
  let url: URL;
  try {
    url = new URL(route.baseUrl);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    Number(url.port) < 1 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/codex-gateway\/[a-f0-9]{48}$/.test(url.pathname) ||
    route.baseUrl !== `http://127.0.0.1:${url.port}${url.pathname}`
  )
    invalid();
  const selection =
    route.selection === undefined ? undefined : { ...route.selection };
  if (
    selection &&
    (!isSyntacticallyValidModelId(selection.modelId) ||
      typeof selection.fundingKey !== 'string' ||
      !/^[a-f0-9]{64}$/.test(selection.fundingKey))
  )
    invalid();
  const model = { ...route.model };
  if (
    !isSyntacticallyValidModelId(model.id) ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow < 1 ||
    !Number.isSafeInteger(model.outputLimit) ||
    model.outputLimit < 1 ||
    model.outputLimit > model.contextWindow ||
    typeof model.supportsVision !== 'boolean'
  )
    invalid();
  const headers = { ...route.headers };
  if (Object.keys(headers).length > ATTRIBUTION_HEADERS.size) invalid();
  for (const [name, value] of Object.entries(headers)) {
    if (
      !ATTRIBUTION_HEADERS.has(name) ||
      typeof value !== 'string' ||
      (name === MODEL_LIBRARY_PROTOCOL_HEADER &&
        value !== String(MODEL_LIBRARY_PROTOCOL_VERSION)) ||
      value.length > 2048 ||
      /[^\x20-\x7e]/.test(value)
    )
      invalid();
  }
  const rawModelId = `canopy-inference/${model.id}`;
  try {
    toOpenCodeModelId(rawModelId);
  } catch {
    return invalid();
  }
  const identity = {
    version: 1,
    bindingKey: route.bindingKey,
    protocol: route.protocol,
    modelId: model.id,
    workOwner: headers[AI_CREDITS_WORK_OWNER_HEADER],
    organizationProjectId: headers[AI_CREDITS_ORG_PROJECT_HEADER],
  };
  const config = {
    enabled_providers: ['canopy-inference'],
    model: rawModelId,
    small_model: rawModelId,
    provider: {
      'canopy-inference': {
        npm:
          route.protocol === 'anthropic-messages'
            ? '@ai-sdk/anthropic'
            : '@ai-sdk/openai',
        options: {
          apiKey: 'canopy-loopback-broker',
          baseURL: `${route.baseUrl}${route.protocol === 'anthropic-messages' ? '/v1' : ''}`,
          headers,
        },
        models: {
          [model.id]: {
            id: model.id,
            name: model.id,
            tool_call: true,
            limit: { context: model.contextWindow, output: model.outputLimit },
            modalities: {
              input: model.supportsVision ? ['text', 'image'] : ['text'],
              output: ['text'],
            },
          },
        },
      },
    },
  };
  return {
    route: {
      bindingKey: route.bindingKey,
      protocol: route.protocol,
      baseUrl: route.baseUrl,
      model,
      headers,
      ...(selection ? { selection } : {}),
    },
    ...(selection
      ? {
          selection: {
            modelId: selection.modelId,
            fundingDigest: openCodeCapabilityDigest({
              version: 1,
              fundingKey: selection.fundingKey,
              workOwner: headers[AI_CREDITS_WORK_OWNER_HEADER],
              organizationProjectId: headers[AI_CREDITS_ORG_PROJECT_HEADER],
            }),
          },
        }
      : {}),
    rawModelId,
    config,
    identityDigest: openCodeCapabilityDigest(identity),
    settingsDigest: openCodeCapabilityDigest({ ...identity, model }),
  };
}

/** Verify saved inference authority before a resume or fork touches native history. */
export function assertOpenCodeInferenceBinding(
  binding: OpenCodeCapabilityBinding,
  inference: ReturnType<typeof prepareOpenCodeInferenceRoute> | undefined,
  allowModelChange = false,
): void {
  const previous = binding.inferenceSelection;
  const selected = inference?.selection;
  const sameFunding =
    previous !== undefined &&
    selected !== undefined &&
    previous.fundingDigest === selected.fundingDigest;
  const modelChanged =
    previous !== undefined &&
    selected !== undefined &&
    previous.modelId !== selected.modelId;
  if (
    (previous !== undefined &&
      (!sameFunding || (modelChanged && !allowModelChange))) ||
    (binding.inferenceRouteDigest !== inference?.identityDigest &&
      !(allowModelChange && sameFunding && modelChanged))
  )
    throw new Error(
      'OpenCode inference route changed. Start a new chat to use this billing selection.',
    );
}
