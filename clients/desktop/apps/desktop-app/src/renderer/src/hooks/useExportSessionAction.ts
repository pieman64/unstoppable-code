import { useCallback, useState } from 'react';
import { shareSessionAction } from '@/lib/shareSessionAction';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';

interface ExportSessionTarget {
  chatId: string;
  ownerDocument?: Document;
}

interface ExportSessionActionController {
  target: ExportSessionTarget | null;
  open: (chatId: string, ownerDocument?: Document) => void;
  close: () => void;
  confirm: () => void;
}

export function useExportSessionAction(
  projectId: string | null,
  worktreeId: string | null,
): ExportSessionActionController {
  const [target, setTarget] = useState<ExportSessionTarget | null>(null);

  const open = useCallback((chatId: string, ownerDocument?: Document): void => {
    setTarget({ chatId, ...(ownerDocument ? { ownerDocument } : {}) });
  }, []);
  const close = useCallback((): void => setTarget(null), []);
  const confirm = useCallback((): void => {
    if (projectId === null || worktreeId === null || target === null) return;
    const { chatId, ownerDocument } = target;
    setTarget(null);
    useCloudConnectGateStore.getState().requestConnect({}, () => {
      void shareSessionAction(
        { projectId, worktreeId, chatId },
        { ...(ownerDocument ? { ownerDocument } : {}) },
      );
    });
  }, [projectId, target, worktreeId]);

  return { target, open, close, confirm };
}
