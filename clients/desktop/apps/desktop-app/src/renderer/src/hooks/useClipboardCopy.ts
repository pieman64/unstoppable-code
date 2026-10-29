import { useCallback, useEffect, useRef, useState } from 'react';
import { copyTextToClipboard } from '@/lib/clipboard';

const DEFAULT_COPIED_DURATION_MS = 1500;

interface UseClipboardCopyOptions {
  copiedDurationMs?: number;
  onCopy?: () => void;
}

interface UseClipboardCopyResult {
  copied: boolean;
  copiedKey: string | null;
  copy: (text: string, copiedKey?: string) => Promise<boolean>;
  clearCopied: () => void;
}

export function useClipboardCopy(
  options?: UseClipboardCopyOptions,
): UseClipboardCopyResult {
  const [copied, setCopied] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedDurationMs =
    options?.copiedDurationMs ?? DEFAULT_COPIED_DURATION_MS;
  const onCopy = options?.onCopy;

  const clearTimer = useCallback((): void => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const clearCopied = useCallback((): void => {
    clearTimer();
    setCopied(false);
    setCopiedKey(null);
  }, [clearTimer]);

  useEffect((): (() => void) => {
    return (): void => {
      clearTimer();
    };
  }, [clearTimer]);

  const markCopied = useCallback(
    (key?: string): void => {
      setCopied(true);
      setCopiedKey(key ?? null);
      clearTimer();
      timeoutRef.current = setTimeout((): void => {
        setCopied(false);
        setCopiedKey(null);
        timeoutRef.current = null;
      }, copiedDurationMs);
    },
    [clearTimer, copiedDurationMs],
  );

  const copy = useCallback(
    async (text: string, key?: string): Promise<boolean> => {
      const success = await copyTextToClipboard(text);
      if (!success) {
        return false;
      }
      markCopied(key);
      onCopy?.();
      return true;
    },
    [markCopied, onCopy],
  );

  return { copied, copiedKey, copy, clearCopied };
}
