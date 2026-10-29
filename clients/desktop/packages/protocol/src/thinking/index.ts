/**
 * Canonical thinking levels shared by every host and UI surface.
 *
 * `low` remains valid for persisted/provider configuration, but UI controls
 * display and cycle it as `medium`. Legacy persisted `auto` values migrate to
 * `high`.
 */
export const THINKING_LEVELS = [
  'off',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingUiLevel = Exclude<ThinkingLevel, 'low'>;
/** UI state for a concrete override or the model/provider default. */
export type ThinkingSetting = 'default' | ThinkingLevel;
export type ThinkingUiSetting = 'default' | ThinkingUiLevel;
/** Wire update: `null` clears a sticky override; omission preserves it. */
export type ThinkingUpdate = ThinkingLevel | null;

export const THINKING_UI_LEVELS: readonly ThinkingUiLevel[] = [
  'off',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

export const THINKING_LEVEL_LABELS: Readonly<Record<ThinkingUiLevel, string>> =
  {
    off: 'None',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max',
    ultra: 'Ultra',
  };

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

export function isThinkingSetting(value: unknown): value is ThinkingSetting {
  return value === 'default' || isThinkingLevel(value);
}

export function encodeThinkingSetting(
  setting: ThinkingSetting,
): ThinkingUpdate {
  return setting === 'default' ? null : setting;
}

export function normalizePersistedThinkingLevel(
  value: unknown,
  fallback: ThinkingLevel,
): ThinkingLevel {
  if (typeof value !== 'string') return fallback;
  if (value === 'auto') return 'high';
  return isThinkingLevel(value) ? value : fallback;
}

export function normalizeThinkingForUi(level: ThinkingLevel): ThinkingUiLevel {
  if (level === 'low') return 'medium';
  return level;
}

/** Permanent cycle fallback for legacy hosts without model capability data. */
export function providerFallbackThinkingLevels(
  providerHint: string | undefined,
): readonly ThinkingLevel[] {
  if (
    providerHint === 'unknown' ||
    providerHint === 'cursor' ||
    providerHint === 'copilot' ||
    providerHint === 'opencode'
  )
    return [];
  return providerHint === 'codex'
    ? ['off', 'medium', 'high', 'xhigh']
    : ['off', 'medium', 'high', 'xhigh', 'max'];
}

export function clampThinkingLevel(
  level: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel {
  if (supported.length === 0) return 'off';
  const ui = normalizeThinkingForUi(level);
  if (supported.includes(ui)) return ui;
  for (let i = THINKING_LEVELS.indexOf(ui); i >= 0; i -= 1) {
    const candidate = THINKING_LEVELS[i];
    if (
      candidate !== undefined &&
      candidate !== 'low' &&
      supported.includes(candidate)
    ) {
      return candidate;
    }
  }
  const first = supported.find((entry) => entry !== 'low');
  return first ?? 'off';
}

/**
 * Wire-level clamp: always returns a member of the model's DECLARED set (or
 * `off` for an empty set, which callers treat as "omit the override").
 *
 * {@link clampThinkingLevel} is a UI clamp — it never returns `low` (which
 * displays as Medium), so for a set whose only member is `low` it falls back
 * to `off`, a level the host never declared. Payload builders must use this
 * variant instead: it reuses the UI clamp, but when that result is not in the
 * declared set it returns the weakest declared level — preserving `low` when
 * it is the only declared option.
 */
export function clampThinkingLevelToDeclared(
  level: ThinkingLevel,
  declared: readonly ThinkingLevel[],
): ThinkingLevel {
  const clamped = clampThinkingLevel(level, declared);
  if (declared.includes(clamped)) return clamped;
  // The UI clamp only leaves the set via its terminal `off` fallback, which is
  // reachable exactly when the declared set has no non-`low` member.
  const weakest = THINKING_LEVELS.find((candidate) =>
    declared.includes(candidate),
  );
  return weakest ?? 'off';
}

export function advanceThinkingLevel(
  level: ThinkingLevel,
  supported: readonly ThinkingLevel[],
): ThinkingLevel {
  const cycle = supported.filter(
    (entry): entry is ThinkingUiLevel => entry !== 'low',
  );
  if (cycle.length === 0) return 'off';
  const current = clampThinkingLevel(level, cycle);
  const index = cycle.indexOf(normalizeThinkingForUi(current));
  return cycle[(index + 1) % cycle.length] ?? 'off';
}

export function thinkingDotCount(
  level: ThinkingLevel,
  supported: readonly ThinkingLevel[],
  providerHint: string | undefined,
): 0 | 1 | 2 | 3 {
  const clamped = clampThinkingLevel(level, supported);
  if (providerHint === 'codex') {
    return clamped === 'medium'
      ? 1
      : clamped === 'high'
        ? 2
        : clamped === 'off' || clamped === 'low'
          ? 0
          : 3;
  }
  return clamped === 'high'
    ? 1
    : clamped === 'xhigh'
      ? 2
      : clamped === 'max' || clamped === 'ultra'
        ? 3
        : 0;
}
