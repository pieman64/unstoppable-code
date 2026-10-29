export type SplitPlanIssueCode =
  | 'unassigned-hunk'
  | 'duplicate-hunk'
  | 'duplicate-child-index'
  | 'unknown-file'
  | 'unknown-hunk-index'
  | 'shared-file-not-stacked'
  | 'dependson-forward-ref'
  | 'dependson-cycle'
  | 'binary-not-whole'
  | 'non-modified-not-whole'
  | 'rename-split'
  | 'aggregate-mismatch'
  | 'depth-warning'
  | 'fragment-warning'
  | 'multi-parent-unsupported';

export interface SplitPlanIssue {
  code: SplitPlanIssueCode;
  severity: 'error' | 'warning';
  message: string;
  childIndex?: number;
  file?: string;
  hunkIndex?: number;
}

export interface SplitPlanValidation {
  valid: boolean;
  issues: SplitPlanIssue[];
}
