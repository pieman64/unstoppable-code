import type {
  CanopyApi,
  PlanDetectionPreferences,
  PlanDetectionRule,
} from '@canopy/desktop-shared/types';
import { BUILTIN_PLAN_DETECTION_RULES } from '@canopy/desktop-shared/plan-detection';
import type { InheritedRuleRow } from '@/components/shared/PlanDetectionRulesEditor';

export interface PlanDetectionTabState {
  status: 'loading' | 'ready' | 'error';
  planDetection?: PlanDetectionPreferences;
}

export async function loadPlanDetectionTabState(
  api: CanopyApi,
): Promise<PlanDetectionTabState> {
  try {
    const prefs = await api.loadPreferences();
    return { status: 'ready', planDetection: prefs.planDetection };
  } catch {
    return { status: 'error' };
  }
}

/** Built-in rules rendered as inherited rows, reflecting the disabled set. */
export function getGlobalInheritedRows(
  prefs: PlanDetectionPreferences,
): InheritedRuleRow[] {
  const disabled = new Set(prefs.disabledBuiltinRuleIds);
  return BUILTIN_PLAN_DETECTION_RULES.map((rule: PlanDetectionRule) => ({
    rule,
    origin: 'built-in',
    disabled: disabled.has(rule.id),
  }));
}

export function getWorkspaceInheritedRows(args: {
  globalPrefs: PlanDetectionPreferences;
  canopyRules: PlanDetectionRule[];
  disabledRuleIds: string[];
}): InheritedRuleRow[] {
  const disabled = new Set(args.disabledRuleIds);
  const globalDisabled = new Set(args.globalPrefs.disabledBuiltinRuleIds);
  const rows: InheritedRuleRow[] = [];
  for (const rule of BUILTIN_PLAN_DETECTION_RULES) {
    if (globalDisabled.has(rule.id)) {
      continue; // already off globally
    }
    rows.push({ rule, origin: 'global', disabled: disabled.has(rule.id) });
  }
  for (const rule of args.globalPrefs.customRules) {
    if (!rule.enabled) {
      continue;
    }
    rows.push({ rule, origin: 'global', disabled: disabled.has(rule.id) });
  }
  for (const rule of args.canopyRules) {
    rows.push({ rule, origin: 'canopy.json', disabled: disabled.has(rule.id) });
  }
  return rows;
}

export function makeRuleId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `rule-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
