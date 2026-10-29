import path from 'node:path';
import { writeJson } from './fsHelpers.mjs';

/**
 * Seed a worktree's persisted code-review state (armed flag, comment
 * threads, annotation artifact, diagrams) before launching Electron.
 *
 * On-disk path: `workspaces/{workspaceId}/worktree-data/{worktreeId}/code-review.json`
 * (`apps/desktop-app/src/main/lib/paths.ts` `getCodeReviewStateFilePath`, via
 * `getWorktreeDataDir` — a workspace-scoped sibling directory, never inside
 * the git worktree checkout itself).
 *
 * Shape (`CodeReviewFile` in `packages/desktop-shared/src/types/code-review.ts`):
 *   { version: 1, armed: boolean, armedAt?: string,
 *     commentThreads: ReviewCommentThread[],
 *     annotations?: CodeReviewArtifact<ReviewAnnotationSet>,
 *     diagrams: CodeReviewDiagrams }
 *
 * The reader (`readCodeReviewState` -> `normalizeCodeReviewFile`) only
 * accepts `version === 1`; malformed threads/annotations are dropped rather
 * than failing the whole file, so this seeder always emits the exact shape
 * `isReviewCommentThread` / `isReviewAnnotation` expect.
 *
 * Repo-id note: `listReviewRepos` emits `repoId: 'default'` for single-repo
 * projects while `ChangedFileInfo.repoId` is `undefined` there —
 * `normalizeRepoKey` treats both as equivalent when matching threads/
 * annotations to the selected file. Callers seeding a single-repo project
 * should pass `repoId: 'default'` on every thread anchor and annotation.
 *
 * @param {object} options
 * @param {string} options.userDataDir absolute CANOPY_DATA_DIR
 * @param {string} options.workspaceId workspace id (a.k.a. projectId)
 * @param {string} options.worktreeId worktree id
 * @param {boolean} [options.armed] defaults to `true`
 * @param {string} [options.armedAt] defaults to a fixed ISO timestamp when `armed`
 * @param {import('@canopy/desktop-shared/types/code-review').ReviewCommentThread[]} [options.commentThreads]
 * @param {import('@canopy/desktop-shared/types/code-review').ReviewAnnotation[]} [options.annotations]
 *   convenience: wrapped into a ready `annotations` artifact
 *   (`{ data: { schemaVersion: 1, annotations }, derivedFromFingerprint,
 *   status: 'ready', generatedAt }`) unless `options.annotationsArtifact` is
 *   supplied instead.
 * @param {import('@canopy/desktop-shared/types/code-review').CodeReviewArtifact<import('@canopy/desktop-shared/types/code-review').ReviewAnnotationSet>} [options.annotationsArtifact]
 *   full artifact envelope; overrides `options.annotations` when provided.
 * @param {string} [options.derivedFromFingerprint] fingerprint stamped onto
 *   the default annotations artifact; any string is accepted (the reader
 *   never re-derives or validates it against the live diff).
 * @param {import('@canopy/desktop-shared/types/code-review').CodeReviewDiagrams} [options.diagrams]
 *   defaults to `{}` (no logic/data-model diagram artifacts seeded).
 * @returns {{
 *   filePath: string,
 *   file: import('@canopy/desktop-shared/types/code-review').CodeReviewFile,
 * }}
 */
export function seedCodeReviewState(options) {
  const {
    userDataDir,
    workspaceId,
    worktreeId,
    armed = true,
    armedAt,
    commentThreads = [],
    annotations,
    annotationsArtifact,
    derivedFromFingerprint = 'seeded-fingerprint',
    diagrams = {},
  } = options ?? {};

  if (!userDataDir) {
    throw new Error('seedCodeReviewState requires userDataDir');
  }
  if (!workspaceId) {
    throw new Error('seedCodeReviewState requires workspaceId');
  }
  if (!worktreeId) {
    throw new Error('seedCodeReviewState requires worktreeId');
  }
  if (!Array.isArray(commentThreads)) {
    throw new Error(
      'seedCodeReviewState requires commentThreads to be an array',
    );
  }

  /** @type {import('@canopy/desktop-shared/types/code-review').CodeReviewFile} */
  const file = {
    version: 1,
    armed,
    ...(armed ? { armedAt: armedAt ?? '2026-04-10T12:00:00.000Z' } : {}),
    commentThreads,
    diagrams,
  };

  if (annotationsArtifact) {
    file.annotations = annotationsArtifact;
  } else if (annotations) {
    if (!Array.isArray(annotations)) {
      throw new Error(
        'seedCodeReviewState requires annotations to be an array',
      );
    }
    file.annotations = {
      data: { schemaVersion: 1, annotations },
      derivedFromFingerprint,
      status: 'ready',
      generatedAt: '2026-04-10T12:00:00.000Z',
    };
  }

  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktree-data',
    worktreeId,
    'code-review.json',
  );

  writeJson(filePath, file);
  return { filePath, file };
}
