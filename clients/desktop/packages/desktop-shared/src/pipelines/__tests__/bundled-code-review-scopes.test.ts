import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveActionRuntime } from '../../node/pipelines/action-resolver';
import { executionContextSatisfies } from '../scope';
import { normalizePipeline } from '../normalize-pipeline';
import { parsePipelineText } from '../parse-pipeline';

const CODE_REVIEW_PIPELINES = [
  {
    id: 'bundled-code-review-multi-provider',
    file: 'code-review-multi-provider.yaml',
  },
  { id: 'bundled-code-review-claude', file: 'code-review-claude.yaml' },
  { id: 'bundled-code-review-codex', file: 'code-review-codex.yaml' },
] as const;

const CODE_REVIEW_ACTIONS = [
  'git-workspace-details',
  'github-fetch-branch-pr',
  'github-post-review-comment',
] as const;

const resourcesDir = join(
  process.cwd(),
  'packages',
  'desktop-shared',
  'resources',
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readIndexedScopes(pipelineId: string): string[] {
  const parsed: unknown = JSON.parse(
    readFileSync(join(resourcesDir, 'pipelines', 'index.json'), 'utf8'),
  );
  if (!isRecord(parsed) || !isUnknownArray(parsed.pipelines)) {
    throw new Error('Invalid bundled pipeline index fixture');
  }

  const entry = parsed.pipelines.find(
    (candidate) => isRecord(candidate) && candidate.id === pipelineId,
  );
  if (!isRecord(entry) || !isUnknownArray(entry.scopes)) {
    throw new Error(`Missing scopes for bundled pipeline ${pipelineId}`);
  }

  return entry.scopes.map((scope) => {
    if (typeof scope !== 'string') {
      throw new Error(`Invalid scope for bundled pipeline ${pipelineId}`);
    }
    return scope;
  });
}

describe('bundled code-review directory scopes', () => {
  it.each(CODE_REVIEW_PIPELINES)(
    'validates $file for directory and worktree execution',
    ({ id, file }) => {
      const raw = readFileSync(join(resourcesDir, 'pipelines', file), 'utf8');
      const normalized = normalizePipeline(parsePipelineText(raw));

      expect(normalized.scope).toEqual(['directory', 'worktree']);
      expect(readIndexedScopes(id)).toEqual(normalized.scope);
      expect(executionContextSatisfies(normalized.scope, 'directory')).toBe(
        true,
      );
      expect(executionContextSatisfies(normalized.scope, 'worktree')).toBe(
        true,
      );
    },
  );

  it.each(CODE_REVIEW_ACTIONS)(
    'allows builtin/%s in a directory-scoped review run',
    (actionName) => {
      const actionsDir = join(resourcesDir, 'actions');
      const action = resolveActionRuntime(`builtin/${actionName}`, {
        bundledActionsDir: actionsDir,
        getProjectActionsDir: (repoPath) =>
          join(repoPath, '.canopy', 'actions'),
      });

      expect(action).not.toBeNull();
      expect(
        executionContextSatisfies(action?.definition.scopes ?? [], 'directory'),
      ).toBe(true);
    },
  );
});
