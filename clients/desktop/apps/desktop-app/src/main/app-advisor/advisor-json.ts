import type { AppAdvisorJson } from '@canopy/desktop-shared/types';

/** Converts a main owner's JSON-safe result without bypassing the action JSON contract. */
export function toAdvisorJson(value: unknown): AppAdvisorJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(toAdvisorJson);
  if (typeof value === 'object') {
    const result: Record<string, AppAdvisorJson> = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) result[key] = toAdvisorJson(item);
    return result;
  }
  return null;
}
