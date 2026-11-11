/**
 * The theme variable each entity kind's graph node is painted with. The
 * canvas graph resolves them at draw time and the legend paints its swatches
 * with the same variables, so the two never drift apart.
 */
export const ENTITY_KIND_COLOR_VARIABLES = {
  service: '--bg-accent',
  code: '--bg-success',
  tool: '--bg-warning',
} as const;

export type EntityGraphKind = keyof typeof ENTITY_KIND_COLOR_VARIABLES;
