import { lazy, Suspense, type JSX } from 'react';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useImportProjectsModalStore } from '@/stores/importProjectsModalStore';

const ImportProjectsModal = lazy(() =>
  import('./ImportProjectsModal').then((module) => ({
    default: module.ImportProjectsModal,
  })),
);

/**
 * App-wide host for the bulk Claude/Codex project import flow (CAN-2439) so
 * Settings, the Getting started checklist, the one-time invite, and App
 * Advisor all share one modal. The modal reports its phase through the
 * current-UI-state slice; candidate paths never leave the renderer.
 */
export function ImportProjectsModalHost(): JSX.Element | null {
  const target = useImportProjectsModalStore((state) => state.target);
  const close = useImportProjectsModalStore((state) => state.close);
  const phase = useImportProjectsModalStore((state) => state.phase);
  const openCount = useImportProjectsModalStore((state) => state.openCount);
  useCurrentUiStateReporter(
    'chat.importProjectsModal',
    target ? { open: true, ...(phase ? { phase } : {}) } : null,
  );
  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <ImportProjectsModal key={openCount} target={target} onClose={close} />
    </Suspense>
  );
}
