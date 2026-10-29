import type {
  ExplorerEvidenceType,
  ExplorerFact,
  ExplorerRankedFact,
  EXPLORER_LIVENESS_FILTERS,
} from '@canopy/protocol/settings/organization-memory';

export type FactCorpusMode = 'search' | 'preview';
export type EvidenceFilter = ExplorerEvidenceType | '';
export type LivenessFilter = (typeof EXPLORER_LIVENESS_FILTERS)[number];

/** Everything the Facts view lets a viewer narrow the corpus by. */
export interface FactCorpusFilters {
  readonly mode: FactCorpusMode;
  /** The search box text. */
  readonly query: string;
  /** The search last submitted; corpus search runs only on submit. */
  readonly submittedQuery: string;
  readonly evidenceType: EvidenceFilter;
  readonly liveness: LivenessFilter;
  readonly from: string;
  readonly to: string;
}

/** The Facts view's initial state; its `useState` initializers read these. */
export const INITIAL_FACT_CORPUS_FILTERS: FactCorpusFilters = {
  mode: 'search',
  query: '',
  submittedQuery: '',
  evidenceType: '',
  liveness: 'live',
  from: '',
  to: '',
};

/** Whether nothing narrows the corpus: every filter is still at its initial value. */
export function isDefaultFilters(filters: FactCorpusFilters): boolean {
  return (
    filters.mode === INITIAL_FACT_CORPUS_FILTERS.mode &&
    filters.query === INITIAL_FACT_CORPUS_FILTERS.query &&
    filters.submittedQuery === INITIAL_FACT_CORPUS_FILTERS.submittedQuery &&
    filters.evidenceType === INITIAL_FACT_CORPUS_FILTERS.evidenceType &&
    filters.liveness === INITIAL_FACT_CORPUS_FILTERS.liveness &&
    filters.from === INITIAL_FACT_CORPUS_FILTERS.from &&
    filters.to === INITIAL_FACT_CORPUS_FILTERS.to
  );
}

/** The first page of facts the view holds, and the filters it was read with. */
export interface FactCorpusFirstPage {
  readonly facts: ReadonlyArray<ExplorerFact | ExplorerRankedFact>;
  readonly nextCursor: string | null;
  /** Whether the page was read with default filters. */
  readonly readWithDefaultFilters: boolean;
}

/**
 * Whether the organization has no memory yet, rather than no facts matching a
 * filter: nothing narrows the corpus, and the first page read without filters
 * came back empty with nothing after it. The facts read reports no total, so
 * an empty first page is the answer.
 */
export function isEmptyCorpus(
  filters: FactCorpusFilters,
  page: FactCorpusFirstPage,
): boolean {
  return (
    isDefaultFilters(filters) &&
    page.readWithDefaultFilters &&
    page.facts.length === 0 &&
    page.nextCursor === null
  );
}
