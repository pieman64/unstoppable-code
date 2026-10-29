import type { PipelineInputDef } from '@canopy/desktop-shared/types/pipeline';
import {
  formatJsonInputDefault,
  formatPipelineInputDefault,
  isValidJsonInputValue,
} from './pipelineTriggerInputs';

/**
 * Returns true if the input definition has a constrained typed widget
 * (dropdown for `choice`/`boolean`, number input for `number`). String
 * inputs render as a plain textarea, which is also the raw-override
 * widget — there is nothing to toggle for them.
 *
 * `json` behaves like `string` here: its widget *is* a multiline textarea, so
 * it is identical to the raw-override widget and has nothing to toggle.
 */
export function hasTypedWidget(def: PipelineInputDef): boolean {
  const type = def.type ?? 'string';
  if (type === 'boolean' || type === 'number') {
    return true;
  }
  if (type === 'choice') {
    return (def.options?.length ?? 0) > 0;
  }
  return false;
}

/**
 * Returns true if `value` can be represented by the typed widget for `def`.
 *
 * Empty strings always fit (the widget renders empty / no-selection). Values
 * that violate the type's constraints (a template token in a number field,
 * an option not in the choice list, etc.) are considered raw overrides and
 * should render as a free-form textarea instead.
 */
export function valueFitsTypedWidget(
  value: string,
  def: PipelineInputDef,
): boolean {
  if (value === '') {
    return true;
  }
  const type = def.type ?? 'string';
  if (type === 'string') {
    return true;
  }
  if (type === 'boolean') {
    return value === 'true' || value === 'false';
  }
  if (type === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return false;
    }
    if (def.min !== undefined && parsed < def.min) {
      return false;
    }
    if (def.max !== undefined && parsed > def.max) {
      return false;
    }
    return true;
  }
  if (type === 'choice') {
    return def.options ? def.options.includes(value) : true;
  }
  if (type === 'json') {
    return isValidJsonInputValue(value);
  }
  return true;
}

/**
 * Returns the initial value to display in a typed widget when the action
 * has no explicit user value. Prefers the pipeline-declared `default`, then
 * falls back to a sensible per-type starting point (`'false'` for boolean,
 * the first option for choice, empty for everything else).
 */
export function getTypedInputInitialValue(def: PipelineInputDef): string {
  const type = def.type ?? 'string';
  if (def.default !== undefined) {
    // `json` defaults may be arrays/objects/`null`; serialize rather than
    // stringify so the textarea starts from re-parseable text.
    return type === 'json'
      ? formatJsonInputDefault(def.default)
      : formatPipelineInputDefault(def.default);
  }
  if (type === 'boolean') {
    return 'false';
  }
  if (type === 'choice') {
    return def.options?.[0] ?? '';
  }
  return '';
}
