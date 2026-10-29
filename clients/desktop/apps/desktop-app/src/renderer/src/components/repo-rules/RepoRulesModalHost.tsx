import { lazy, Suspense, type JSX } from 'react';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useRepoRulesModalStore } from '@/stores/repoRulesModalStore';

const RepoRulesModal = lazy(() =>
  import('./RepoRulesModal').then((module) => ({
    default: module.RepoRulesModal,
  })),
);

/**
 * App-wide host for the Cursor rules review (CAN-2053), shared by Settings,
 * Getting started, Project Settings, import results, and App Advisor. Rule
 * paths and contents never leave the renderer through the UI snapshot.
 */
export function RepoRulesModalHost(): JSX.Element | null {
  const target = useRepoRulesModalStore((state) => state.target);
  const close = useRepoRulesModalStore((state) => state.close);
  const openCount = useRepoRulesModalStore((state) => state.openCount);
  useCurrentUiStateReporter(
    'chat.repoRulesModal',
    target ? { open: true, source: target.source } : null,
  );
  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <RepoRulesModal key={openCount} target={target} onClose={close} />
    </Suspense>
  );
}
