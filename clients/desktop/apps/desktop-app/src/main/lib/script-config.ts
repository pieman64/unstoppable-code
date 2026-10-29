import type {
  ScriptInputMap,
  ScriptOverrides,
} from '@canopy/desktop-shared/scripts';
import {
  isScriptDefinition,
  normalizeScriptInputMap,
  normalizeScriptValue,
} from '@canopy/desktop-shared/scripts';

interface LegacyScriptFields {
  scripts?: unknown;
  setupScript?: unknown;
  teardownScript?: unknown;
  runScript?: unknown;
  launchScript?: unknown;
}

export function normalizeLegacyScriptFields(
  raw: LegacyScriptFields,
): ScriptOverrides | undefined {
  const mergedScripts: ScriptInputMap = {};

  const embeddedScripts = normalizeRawScriptMap(raw.scripts);
  if (embeddedScripts) {
    for (const [scriptName, scriptValue] of Object.entries(embeddedScripts)) {
      mergedScripts[scriptName] = scriptValue;
    }
  }

  applyLegacyScriptField(mergedScripts, 'setup', raw.setupScript);
  applyLegacyScriptField(mergedScripts, 'teardown', raw.teardownScript);
  applyLegacyScriptField(mergedScripts, 'launch', raw.launchScript);
  if (mergedScripts.launch === undefined) {
    applyLegacyScriptField(mergedScripts, 'launch', raw.runScript);
  }

  return normalizeScriptInputMap(mergedScripts);
}

function normalizeRawScriptMap(value: unknown): ScriptOverrides | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rawScripts: ScriptInputMap = {};
  for (const [scriptName, scriptValue] of Object.entries(value)) {
    if (
      typeof scriptValue === 'string' ||
      isScriptDefinition(scriptValue) ||
      scriptValue === null ||
      scriptValue === undefined
    ) {
      rawScripts[scriptName] = scriptValue;
    }
  }

  return normalizeScriptInputMap(rawScripts);
}

function applyLegacyScriptField(
  target: ScriptInputMap,
  scriptName: string,
  rawValue: unknown,
): void {
  if (target[scriptName] !== undefined) {
    return;
  }

  if (
    typeof rawValue !== 'string' &&
    rawValue !== null &&
    rawValue !== undefined
  ) {
    return;
  }

  const normalizedValue = normalizeScriptValue(rawValue);
  if (normalizedValue !== undefined) {
    target[scriptName] = normalizedValue;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
