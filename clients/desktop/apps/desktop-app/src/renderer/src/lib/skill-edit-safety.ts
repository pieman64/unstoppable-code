import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import type { SkillFilesResponse } from '@canopy/desktop-shared/types/skills';

type SupportingFilePathsResult =
  | { success: true; paths: string[] }
  | { success: false; error: string };

export function resolveSupportingFilePaths(
  result: IPCResult<SkillFilesResponse>,
): SupportingFilePathsResult {
  if (!result.success || !result.data) {
    return {
      success: false,
      error:
        result.error ||
        'Failed to load supporting files. Saving is disabled to protect existing files.',
    };
  }
  if (result.data.truncated) {
    return {
      success: false,
      error:
        'This skill has too many files to load safely. Saving is disabled to protect files that were not listed.',
    };
  }
  return {
    success: true,
    paths: result.data.files.filter((filePath) => filePath !== 'SKILL.md'),
  };
}

export function isSkillEditorSaveEnabled(input: {
  saving: boolean;
  loading: boolean;
  supportingFilesReady: boolean;
  hasContent: boolean;
}): boolean {
  return (
    !input.saving &&
    !input.loading &&
    input.supportingFilesReady &&
    input.hasContent
  );
}

/** The skill editor's saveable fields, for detecting unsaved changes. */
export interface SkillEditorSnapshotInput {
  name: string;
  description: string;
  body: string;
  metadata: ReadonlyArray<{ key: string; value: string }>;
  files: ReadonlyArray<{ path: string; content: string; editable: boolean }>;
}

/**
 * A comparable fingerprint of the editor's fields. The editor has unsaved
 * changes when its current fingerprint differs from the loaded one.
 */
export function skillEditorSnapshot(input: SkillEditorSnapshotInput): string {
  return JSON.stringify([
    input.name,
    input.description,
    input.body,
    input.metadata.map(({ key, value }) => [key, value]),
    input.files.map(({ path, content, editable }) => [path, content, editable]),
  ]);
}
