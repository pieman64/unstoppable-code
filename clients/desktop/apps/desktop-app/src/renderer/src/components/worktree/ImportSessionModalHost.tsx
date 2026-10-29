import { lazy, Suspense, type JSX } from 'react';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useImportSessionModalStore } from '@/stores/importSessionModalStore';

const ImportSessionModal = lazy(() =>
  import('./ImportSessionModal').then((module) => ({
    default: module.ImportSessionModal,
  })),
);

/** App-wide host so git and Cowork workspace surfaces share one import flow. */
export function ImportSessionModalHost(): JSX.Element | null {
  const target = useImportSessionModalStore((state) => state.target);
  const close = useImportSessionModalStore((state) => state.close);
  useCurrentUiStateReporter(
    'chat.importSessionModal',
    target ? { open: true, workspaceId: target.workspaceId } : null,
  );
  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <ImportSessionModal workspaceId={target.workspaceId} onClose={close} />
    </Suspense>
  );
}
