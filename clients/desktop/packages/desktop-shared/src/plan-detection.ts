import type {
  CanopyJsonPlanDetection,
  PlanDetectionPreferences,
  PlanDetectionRule,
  WorkspacePlanDetectionConfig,
} from './types';

/**
 * Built-in plan-detection rules, structured like `file-indexing.ts`. Ids are
 * stable kebab-case strings; never change a shipped id. A finer tier disables
 * a built-in by adding its id to its disabled set.
 */
export const BUILTIN_PLAN_DETECTION_RULES: readonly PlanDetectionRule[] = [
  {
    id: 'superpowers-specs',
    label: 'Superpowers Specs',
    kind: 'include',
    pattern: 'docs/superpowers/specs/*.md',
    enabled: true,
  },
  {
    id: 'superpowers-designs',
    label: 'Superpowers Designs',
    kind: 'exclude',
    pattern: 'docs/superpowers/specs/*-design.md',
    enabled: true,
  },
  {
    id: 'plan-md',
    label: 'Plan Files',
    kind: 'include',
    pattern: '**/plan.md',
    enabled: true,
  },
] as const;

/**
 * Set of every valid built-in rule id, used by preference normalization to
 * drop unknown entries from a persisted disabled-id list.
 */
export const BUILTIN_PLAN_DETECTION_RULE_IDS: ReadonlySet<string> = new Set(
  BUILTIN_PLAN_DETECTION_RULES.map((rule) => rule.id),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsolutePlanDetectionPattern(pattern: string): boolean {
  return pattern.startsWith('/') || /^[a-zA-Z]:\//.test(pattern);
}

export function normalizePlanDetectionRule(
  value: unknown,
): PlanDetectionRule | null {
  if (!isRecord(value)) {
    return null;
  }
  const pattern =
    typeof value.pattern === 'string'
      ? value.pattern.trim().replace(/\\/g, '/')
      : '';
  const id =
    typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
  const label = typeof value.label === 'string' ? value.label.trim() : '';
  const kind =
    value.kind === 'include' || value.kind === 'exclude' ? value.kind : null;
  if (!pattern || !id || !kind) {
    return null;
  }
  if (
    pattern.split('/').includes('..') ||
    isAbsolutePlanDetectionPattern(pattern)
  ) {
    return null;
  }
  return {
    id,
    label: label || id,
    kind,
    pattern,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
  };
}

/**
 * Look up a built-in by id. Returns `undefined` if no built-in matches —
 * useful when surfacing migrations or settings UI errors for unknown ids.
 */
export function getBuiltinPlanDetectionRule(
  id: string,
): PlanDetectionRule | undefined {
  return BUILTIN_PLAN_DETECTION_RULES.find((rule) => rule.id === id);
}

export interface ResolvePlanDetectionRulesInput {
  global: PlanDetectionPreferences;
  workspaceLocal?: WorkspacePlanDetectionConfig;
  canopyJson?: CanopyJsonPlanDetection;
}

export interface ResolvedPlanDetectionRules {
  includes: PlanDetectionRule[];
  excludes: PlanDetectionRule[];
}

/**
 * Union the rules from every tier, apply workspace-local per-id disables, keep
 * enabled rules, and split into include/exclude. Exclude always wins at match
 * time (the matcher in the detection service enforces that).
 */
export function resolvePlanDetectionRules(
  input: ResolvePlanDetectionRulesInput,
): ResolvedPlanDetectionRules {
  const { global, workspaceLocal, canopyJson } = input;
  const disabledBuiltins = new Set(global.disabledBuiltinRuleIds);

  const merged = new Map<string, PlanDetectionRule>();
  for (const rule of BUILTIN_PLAN_DETECTION_RULES) {
    if (!disabledBuiltins.has(rule.id)) {
      merged.set(rule.id, rule);
    }
  }
  for (const rule of global.customRules) {
    merged.set(rule.id, rule);
  }
  for (const rule of canopyJson?.rules ?? []) {
    merged.set(rule.id, rule);
  }
  for (const rule of workspaceLocal?.customRules ?? []) {
    merged.set(rule.id, rule);
  }

  const disabledByWorkspace = new Set(workspaceLocal?.disabledRuleIds ?? []);
  const includes: PlanDetectionRule[] = [];
  const excludes: PlanDetectionRule[] = [];
  for (const rule of Array.from(merged.values())) {
    if (!rule.enabled || disabledByWorkspace.has(rule.id)) {
      continue;
    }
    (rule.kind === 'exclude' ? excludes : includes).push(rule);
  }
  return { includes, excludes };
}
