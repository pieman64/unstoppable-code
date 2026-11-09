import { useCallback, useEffect, useRef, useState } from 'react';
import type { StartMcpOAuthLoginRequest } from '@canopy/execution-engine/types/mcp-servers';

/** An explicit marketplace connection. Passive status reads never start auth. */
export function useMarketplaceOAuth(): {
  start: (request: StartMcpOAuthLoginRequest) => Promise<void>;
  finish: (error?: string) => void;
  pending: boolean;
  url: string | null;
  error: string | null;
  clearError: () => void;
  closeBrowser: () => void;
} {
  const [pending, setPending] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clearError = useCallback((): void => setError(null), []);
  const generation = useRef(0);
  const busy = useRef(false);
  const flowId = useRef<string | undefined>(undefined);
  const cancel = useCallback((): void => {
    const id = flowId.current;
    flowId.current = undefined;
    if (id) void window.mcpServers.cancelOAuthLogin(id).catch(() => undefined);
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => (): void => {
      generation.current += 1;
      cancel();
      clearTimeout(timer.current);
    },
    [cancel],
  );
  const finish = useCallback(
    (message?: string): void => {
      generation.current += 1;
      cancel();
      busy.current = false;
      clearTimeout(timer.current);
      setPending(false);
      setUrl(null);
      setError(message ?? null);
    },
    [cancel],
  );
  const start = useCallback(
    async (request: StartMcpOAuthLoginRequest): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      const run = ++generation.current;
      setPending(true);
      setError(null);
      setUrl(null);
      try {
        const response = await window.mcpServers.startOAuthLogin({
          ...request,
          browser: 'embedded',
        });
        if (generation.current !== run) {
          if (response.flowId)
            await window.mcpServers.cancelOAuthLogin(response.flowId);
          return;
        }
        flowId.current = response.flowId;
        if (response.status === 'completed') {
          finish();
        } else if (response.authorizationUrl) {
          setUrl(response.authorizationUrl);
          timer.current = setTimeout(
            () => finish('Sign-in did not finish. Connect again to retry.'),
            120_000,
          );
        } else {
          finish(
            'The service did not return a sign-in page. Connect again to retry.',
          );
        }
      } catch (cause) {
        if (generation.current === run)
          finish(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [finish],
  );
  return {
    start,
    finish,
    pending,
    url,
    error,
    clearError,
    closeBrowser: () => finish(),
  };
}
