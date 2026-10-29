export interface ReleaseHighlight {
  readonly title: string;
  readonly description?: string;
}

export interface ReleaseNotesDetail {
  readonly heading: string;
  readonly items: readonly string[];
}

export interface ReleaseNotesEntry {
  readonly version: string;
  /** Absent until the release is approved for public publication. */
  readonly releasedOn?: string;
  readonly headline?: string;
  readonly highlights: readonly ReleaseHighlight[];
  readonly details?: readonly ReleaseNotesDetail[];
}

export interface ParsedReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly rc: number | null;
  /** Stable identity shared by all RCs and the stable build. */
  readonly normalized: string;
}

export interface ReleaseHighlightsEligibility {
  readonly currentVersion: string;
  /** Last presented version (older clients may have recorded an install baseline). */
  readonly lastSeenVersion: string | null;
  /** Capture before waiting for onboarding to finish. */
  readonly onboardingCompletedAtInitialSnapshot: boolean;
}

export type ReleaseHighlightsDecision =
  | {
      readonly action: 'show';
      readonly entry: ReleaseNotesEntry;
      readonly version: string;
    }
  | { readonly action: 'none' };
