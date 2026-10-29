import { useEffect, useState } from 'react';
import type { OpenCodeModelEntry } from '@canopy/desktop-shared/types';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';

const EMPTY: OpenCodeModelEntry[] = [];

/** The existing host catalog broadcast is the sole renderer model cache. */
export function useOpenCodeModels(
  available: boolean,
  open: boolean,
): { models: OpenCodeModelEntry[]; message?: string } {
  const entries = useModelCatalogStore(
    (state) => state.snapshot?.opencode ?? EMPTY,
  );
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (!available || !open) return;
    let current = true;
    setMessage('Loading OpenCode models…');
    void window.api.opencodeConnection?.listModels().then(
      (models) => {
        if (current)
          setMessage(
            models.length
              ? undefined
              : 'No OpenCode models are available from your configured providers.',
          );
      },
      () => {
        if (current)
          setMessage(
            'Could not load OpenCode models. Reopen this menu to retry.',
          );
      },
    );
    return (): void => {
      current = false;
    };
  }, [available, open]);
  return {
    models: available ? entries : EMPTY,
    message: available ? message : undefined,
  };
}
