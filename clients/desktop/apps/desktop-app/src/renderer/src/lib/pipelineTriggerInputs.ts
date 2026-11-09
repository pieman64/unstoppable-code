import type {
  Pipeline,
  PipelineInputDef,
  PipelineInputValue,
  PipelineTriggerType,
} from '@canopy/execution-engine/types/pipeline';
import { getTriggerInputDefs } from '@canopy/execution-engine/types/pipeline';
import { isPipelineInputValue } from '@canopy/desktop-shared/pipelines/json-values';
import type { NormalizedPipeline } from '@canopy/desktop-shared/pipelines/types';
import { normalizePipeline } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import { getDefaultShellForRenderer } from './default-shell';

export interface TriggerInputResolution {
  inputDefs: Record<string, PipelineInputDef>;
  error: string | null;
}

export function shouldShowPipelineInputInUi(def: PipelineInputDef): boolean {
  if (def['hint-hide-ui-option'] !== true) {
    return true;
  }

  return def.required === true && def.default === undefined;
}

export function getVisibleTriggerInputDefs(
  defs: Record<string, PipelineInputDef>,
): Record<string, PipelineInputDef> {
  return Object.fromEntries(
    Object.entries(defs).filter(([, def]) => shouldShowPipelineInputInUi(def)),
  );
}

/**
 * Resolve the input definitions for a given trigger type.
 *
 * Checks `trigger_inputs[triggerType]` first (normalized pipelines),
 * then falls back to the raw trigger config via `getTriggerInputDefs`.
 */
export function resolveTriggerInputDefs(
  pipeline: NormalizedPipeline,
  triggerType: PipelineTriggerType,
  rawTrigger?: Parameters<typeof getTriggerInputDefs>[0],
): Record<string, PipelineInputDef> {
  const fromNormalized = pipeline.trigger_inputs?.[triggerType];
  if (fromNormalized && Object.keys(fromNormalized).length > 0) {
    return fromNormalized;
  }

  const fromRaw =
    rawTrigger != null
      ? getTriggerInputDefs(rawTrigger, triggerType)
      : undefined;
  return fromRaw ?? {};
}

/**
 * Resolve trigger inputs directly from raw pipeline content.
 *
 * Invalid or legacy stored pipelines can fail normalization; return an error
 * so callers can keep the UI in a recoverable state.
 */
export function resolvePipelineTriggerInputs(
  pipeline: Pipeline | null,
  triggerType: PipelineTriggerType,
): TriggerInputResolution {
  if (!pipeline) {
    return {
      inputDefs: {},
      error: null,
    };
  }

  try {
    const normalized = normalizePipeline(pipeline, {
      defaultShell: getDefaultShellForRenderer(),
    });
    return {
      inputDefs: resolveTriggerInputDefs(normalized, triggerType, pipeline.on),
      error: null,
    };
  } catch (error: unknown) {
    return {
      inputDefs: {},
      error:
        error instanceof Error
          ? error.message
          : 'Failed to load workflow trigger inputs',
    };
  }
}

/**
 * Copy for the `json` (structured) trigger input widget. Kept here so the
 * modal, the settings editor, and validation all read the same strings.
 */
export const JSON_INPUT_HELPER_TEXT = 'Enter a JSON array, object, or value.';
export const JSON_INPUT_ERROR_TEXT = 'Enter valid JSON.';

/**
 * Render any declared input default as display text.
 *
 * `PipelineInputDef.default` is widened to `PipelineInputValue` so `json`
 * inputs can declare array/object/`null` defaults. Scalars keep their exact
 * previous `String(value)` form; structured values are serialized rather than
 * stringified, because `String({})` renders `[object Object]`.
 */
export function formatPipelineInputDefault(
  value: PipelineInputValue | undefined,
): string {
  if (value === undefined) {
    return '';
  }
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Render a declared default as the text the `json` textarea starts from.
 *
 * `type: 'json'` defaults may be arrays, objects, scalars, or `null`, so they
 * are serialized as JSON rather than stringified — `String({})` would render
 * `[object Object]` and would not re-parse.
 */
export function formatJsonInputDefault(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, null, 2);
}

/**
 * Parse a `json` trigger input's raw text into a **recursively validated**
 * JSON-safe value.
 *
 * Returns `undefined` when the text does not parse, or when the parsed result
 * is not JSON-safe all the way down (`isPipelineInputValue` walks nested
 * arrays and objects). Arrays, object maps, scalars, and `null` are all valid
 * results — `null` is a legitimate value here, which is why the failure signal
 * is `undefined` rather than `null`.
 *
 * Empty text is *not* handled here: required/optional handling belongs to
 * {@link validateInputs}.
 *
 * This is the renderer's validation gate only. The accepted value is forwarded
 * as the raw string through the existing trigger path; parsing for execution,
 * and `JSON.stringify()` projection into environment variables, both happen
 * backend-side.
 */
export function parseJsonInputValue(
  text: string,
): PipelineInputValue | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isPipelineInputValue(parsed) ? parsed : undefined;
}

/**
 * True when `text` parses as a recursively JSON-safe value. Empty input is
 * *not* validated here — required/optional handling happens in
 * {@link validateInputs}.
 */
export function isValidJsonInputValue(text: string): boolean {
  return parseJsonInputValue(text) !== undefined;
}

/**
 * Initialize form values from input definitions, filling in defaults.
 */
export function initializeInputValues(
  defs: Record<string, PipelineInputDef>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, def] of Object.entries(defs)) {
    if (def.default === undefined) {
      values[name] = '';
      continue;
    }
    values[name] =
      def.type === 'json'
        ? formatJsonInputDefault(def.default)
        : // Non-`json` defaults stay scalar and keep their exact previous
          // serialization.
          formatPipelineInputDefault(def.default);
  }
  return values;
}

/**
 * Initialize form values from input definitions, then overlay caller seeds
 * for input names the pipeline actually declares (own properties only — a
 * seed named `toString`/`constructor` must not pass via the prototype
 * chain). Everything remains user-editable; unknown seed names are dropped.
 */
export function seedInitialInputValues(
  defs: Record<string, PipelineInputDef>,
  initialInputs: Record<string, string> | undefined,
): Record<string, string> {
  const values = initializeInputValues(defs);
  if (!initialInputs) return values;
  for (const [name, value] of Object.entries(initialInputs)) {
    if (Object.prototype.hasOwnProperty.call(defs, name)) {
      values[name] = value;
    }
  }
  return values;
}

/**
 * Validate input values against their definitions.
 * Returns a map of field name -> error message for fields that fail validation.
 * An empty map means all inputs are valid.
 */
export function validateInputs(
  defs: Record<string, PipelineInputDef>,
  values: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [name, def] of Object.entries(defs)) {
    const value = values[name]?.trim() ?? '';
    const inputType = def.type ?? 'string';

    if (def.required && value === '') {
      errors[name] = 'This field is required';
      continue;
    }

    if (value === '') {
      continue;
    }

    if (inputType === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        errors[name] = 'Must be a valid number';
        continue;
      }
      if (def.min !== undefined && parsed < def.min) {
        errors[name] = `Must be at least ${String(def.min)}`;
        continue;
      }
      if (def.max !== undefined && parsed > def.max) {
        errors[name] = `Must be at most ${String(def.max)}`;
        continue;
      }
    }

    if (inputType === 'choice' && def.options && !def.options.includes(value)) {
      errors[name] = `Must be one of: ${def.options.join(', ')}`;
      continue;
    }

    // Structured input: block submission on unparseable JSON. Parsing and
    // normalization of the accepted value is backend-owned — the renderer only
    // gates the raw string it forwards through the existing trigger path.
    if (inputType === 'json' && !isValidJsonInputValue(value)) {
      errors[name] = JSON_INPUT_ERROR_TEXT;
    }
  }
  return errors;
}

/**
 * Build a submission payload from validated input values.
 * Only includes non-empty values.
 */
export function buildSubmitPayload(
  defs: Record<string, PipelineInputDef>,
  values: Record<string, string>,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [name] of Object.entries(defs)) {
    const value = values[name]?.trim() ?? '';
    if (value !== '') {
      payload[name] = value;
    }
  }
  return payload;
}
