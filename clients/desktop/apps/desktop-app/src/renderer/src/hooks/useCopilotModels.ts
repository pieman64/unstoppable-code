import { useEffect, useState } from 'react';
import type { CopilotModelEntry } from '@canopy/desktop-shared/types';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';
import { extractIpcErrorMessage, extractIpcErrorName } from '@/lib/errors';

const EMPTY: CopilotModelEntry[] = [];

/** Main names the failures a retry cannot fix; everything else keeps the retry hint. */
const NAMED_FAILURES = new Set([
  'CopilotPolicyError',
  'CopilotSignInExpiredError',
]);

function describeCopilotModelsFailure(error: unknown): string {
  const name = extractIpcErrorName(error);
  return name && NAMED_FAILURES.has(name)
    ? extractIpcErrorMessage(error)
    : "Couldn't load Copilot models. Reopen this menu to retry.";
}

/** The existing host catalog broadcast is the sole renderer model cache. */
export function useCopilotModels(
  available: boolean,
  open: boolean,
): { models: CopilotModelEntry[]; message?: string } {
  const entries = useModelCatalogStore(
    (state) => state.snapshot?.copilot ?? EMPTY,
  );
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    if (!available || !open) return;
    let current = true;
    setMessage('Loading Copilot models…');
    void window.api.copilotConnection?.listModels().then(
      (models) => {
        if (current)
          setMessage(
            models.length
              ? undefined
              : 'No Copilot models are available for this account.',
          );
      },
      (error: unknown) => {
        if (current) setMessage(describeCopilotModelsFailure(error));
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
