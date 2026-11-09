import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import type { WorkerGitLocalMutationName } from '@canopy/core-runtime/node/git';
import type {
  EnsureRepoShadowOptions,
  RepoShadowInfo,
} from '../lib/repo-shadow';

interface LocalBinding {
  readonly id: string;
  readonly operation: WorkerGitLocalMutationName;
  readonly repoPath: string;
  readonly shadowOptions: EnsureRepoShadowOptions | undefined;
  active: boolean;
  consumed: boolean;
  shadow?: RepoShadowInfo;
}
const bindings = new AsyncLocalStorage<LocalBinding>();
export function consumeLocalGitBinding(
  id: string,
  operation: WorkerGitLocalMutationName,
): LocalBinding {
  const binding = bindings.getStore();
  if (
    !binding ||
    !binding.active ||
    binding.consumed ||
    binding.id !== id ||
    binding.operation !== operation
  )
    throw new CanopyOperationError({
      kind: 'failed_precondition',
      code: 'worker.git.localMutation.bindingUnavailable',
      message: 'The local Git request binding is unavailable.',
      retry: { kind: 'never' },
    });
  binding.consumed = true;
  return binding;
}

/** Paths/options are trusted host inputs, scoped to one instruction, never transport input. */
export async function withLocalGitBinding<Result>(
  operation: WorkerGitLocalMutationName,
  repoPath: string,
  shadowOptions: EnsureRepoShadowOptions | undefined,
  run: (bindingId: string) => Promise<Result>,
): Promise<{ result: Result; shadow?: RepoShadowInfo }> {
  const binding: LocalBinding = {
    id: randomUUID(),
    operation,
    repoPath,
    shadowOptions,
    active: true,
    consumed: false,
  };
  try {
    const result = await bindings.run(binding, () => run(binding.id));
    return {
      result,
      ...(binding.shadow === undefined ? {} : { shadow: binding.shadow }),
    };
  } finally {
    binding.active = false;
  }
}
