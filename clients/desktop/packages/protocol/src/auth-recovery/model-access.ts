/**
 * A turn the provider refused because the signed-in account cannot use the
 * model (CAN-4716). Today only ChatGPT-account Codex rejections are
 * classified; the kind is a union so a later variant (for example an
 * unverified account) only adds a member.
 */
export type CodexAccountModelAccessFailureKind = 'model_unsupported';

/**
 * The structured carrier the desktop stamps on a rejected Codex turn's
 * terminal `result` event and the reducer copies onto that turn's error row.
 * Labels are resolved by the host when the failure is recorded, so every
 * surface renders the same names without a model registry.
 */
export interface CodexAccountModelAccessFailure {
  kind: CodexAccountModelAccessFailureKind;
  /** The model the account was refused. */
  model: string;
  modelLabel: string;
  /** A model the account can run, when one is known. */
  fallbackModel?: string;
  fallbackModelLabel?: string;
}

/** Terminal-event field carrying a {@link CodexAccountModelAccessFailure}. */
export const CANOPY_MODEL_ACCESS_FAILURE_FIELD = 'canopy_model_access_failure';

/** Longest model id or label a carrier may hold. */
export const MAX_MODEL_ACCESS_STRING_LENGTH = 256;

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_MODEL_ACCESS_STRING_LENGTH
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural check for a persisted or projected carrier. A fallback is valid
 * only as a model and label pair.
 */
export function isCodexAccountModelAccessFailure(
  value: unknown,
): value is CodexAccountModelAccessFailure {
  if (!isRecord(value)) return false;
  if (value.kind !== 'model_unsupported') return false;
  if (!isBoundedString(value.model) || !isBoundedString(value.modelLabel)) {
    return false;
  }
  if (value.fallbackModel === undefined) {
    return value.fallbackModelLabel === undefined;
  }
  return (
    isBoundedString(value.fallbackModel) &&
    isBoundedString(value.fallbackModelLabel)
  );
}

/** Copy only the known fields of a valid carrier, or `undefined`. */
export function readCodexAccountModelAccessFailure(
  value: unknown,
): CodexAccountModelAccessFailure | undefined {
  if (!isCodexAccountModelAccessFailure(value)) return undefined;
  return {
    kind: value.kind,
    model: value.model,
    modelLabel: value.modelLabel,
    ...(value.fallbackModel !== undefined &&
    value.fallbackModelLabel !== undefined
      ? {
          fallbackModel: value.fallbackModel,
          fallbackModelLabel: value.fallbackModelLabel,
        }
      : {}),
  };
}
