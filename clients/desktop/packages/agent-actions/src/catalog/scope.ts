import { clampLimit } from './limit';
import type {
  AgentActionSearchResult,
  AgentActionSearchResultAction,
} from './search';

export interface AgentActionScopeRefinement {
  /** Extra fields this action hides, in its fields and every example. */
  hiddenFields?: readonly string[];
  /** Explicit target fields exempt from the global hidden fields for this action. */
  visibleFields?: readonly string[];
  /** Replace the global scope description for explicit-target actions. */
  scopeSummary?: string;
  scopeNote?: string;
  /** Notes appended after the scope note. */
  trailingNotes?: readonly string[];
}

export interface ScopeAgentActionCatalogOptions<
  TAction extends AgentActionSearchResultAction,
> {
  /** Fields the trusted runtime supplies, hidden from every action and example. */
  hiddenFields: readonly string[];
  scopeSummary: string;
  scopeNote: string;
  limit: number | undefined;
  categories: string[];
  refineAction?: (action: TAction) => AgentActionScopeRefinement | undefined;
}

/**
 * Hide fields from one search result action: from its field lists, its
 * example, and every additional example.
 */
export function hideAgentActionFields<
  TAction extends AgentActionSearchResultAction,
>(action: TAction, hiddenFields: ReadonlySet<string>): TAction {
  const visibleField = (name: string): boolean => !hiddenFields.has(name);
  const visibleExample = (example: object): object =>
    Object.fromEntries(
      Object.entries(example).filter(([key]) => visibleField(key)),
    );
  return {
    ...action,
    example: visibleExample(action.example),
    ...(action.additionalExamples
      ? { additionalExamples: action.additionalExamples.map(visibleExample) }
      : {}),
    fields: action.fields.filter((field) => visibleField(field.name)),
    requiredFields: action.requiredFields.filter(visibleField),
    optionalFields: action.optionalFields.filter(visibleField),
  };
}

/**
 * Project a catalog search result onto a scoped agent surface: hide the
 * runtime-supplied fields, describe the applied scope, and window the result.
 */
export function scopeAgentActionCatalog<
  TAction extends AgentActionSearchResultAction,
>(
  result: AgentActionSearchResult<TAction>,
  options: ScopeAgentActionCatalogOptions<TAction>,
): AgentActionSearchResult<TAction> {
  const maxResults = clampLimit(options.limit, 20, 50);
  const actions = result.actions.map((action): TAction => {
    const refinement = options.refineAction?.(action);
    const hidden = hideAgentActionFields(
      action,
      new Set([
        ...options.hiddenFields.filter(
          (field) => !refinement?.visibleFields?.includes(field),
        ),
        ...(refinement?.hiddenFields ?? []),
      ]),
    );
    return {
      ...hidden,
      summary: `${action.summary} ${refinement?.scopeSummary ?? options.scopeSummary}`,
      notes: [
        ...(action.notes ?? []),
        refinement?.scopeNote ?? options.scopeNote,
        ...(refinement?.trailingNotes ?? []),
      ],
    };
  });
  const selected = actions.slice(0, maxResults);
  return {
    ...result,
    totalMatches: actions.length,
    returned: selected.length,
    categories: options.categories,
    actions: selected,
  };
}
