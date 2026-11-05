import type { MemoryImportSourceTool } from './input-budget';

export interface ConsolidationUsageStats {
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ConsolidationInputFile {
  fileKey: string;
  filename: string;
  content: string;
  modifiedAt: string;
  usage: ConsolidationUsageStats;
  importMetadata?: ConsolidationImportMetadata;
}

export interface ConsolidationImportMetadata {
  sourceTool: MemoryImportSourceTool;
  originalPath: string;
  sourceFilename: string;
  repo?: string;
  modified: string;
}

export interface ConsolidationInputOmission {
  fileCount: number;
  totalBytes: number;
}

export interface ConsolidationInput {
  memoryMd: string;
  topicFiles: ConsolidationInputFile[];
  inboxFiles: ConsolidationInputFile[];
  importFiles: ConsolidationInputFile[];
  omittedTopicFiles?: ConsolidationInputOmission;
  omittedInboxFiles?: ConsolidationInputOmission;
  omittedImportFiles?: ConsolidationInputOmission;
  inputHash: string;
  indexWithinLimits: boolean;
  // When usage tracking started for this scope, or null when the usage
  // store is absent or unreadable. Pruning treats null as "usage unknown"
  // and never removes content on it.
  usageTrackingSince: string | null;
}

export interface ConsolidationOutput {
  memoryMd: string;
  topicFiles?: Array<{
    filename: string;
    content: string;
  }>;
}

/**
 * Nothing to consolidate: no pending note or import was selected and the
 * index is within its limits. Files the budgets left out do not count: with
 * nothing selected, a model call could consume none of them.
 */
export function isConsolidationInputClean(input: ConsolidationInput): boolean {
  return (
    input.inboxFiles.length === 0 &&
    input.importFiles.length === 0 &&
    input.indexWithinLimits
  );
}
