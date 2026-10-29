import { useCallback, useEffect, useState } from 'react';
import type { InvocableMentionTarget } from '@/lib/invocableMentionIndex';
import {
  loadInvocableMentionContent,
  type InvocableMentionContent,
} from '@/lib/invocableMentionContent';

/** Loads a skill or command's content once `enabled`, and keeps it. */
export function useInvocableMentionContent(
  target: InvocableMentionTarget,
  enabled: boolean,
): { content: InvocableMentionContent | null; loading: boolean } {
  const [content, setContent] = useState<InvocableMentionContent | null>(null);
  const [loading, setLoading] = useState(false);

  const ensureLoaded = useCallback((): void => {
    if (content || loading) return;
    setLoading(true);
    void loadInvocableMentionContent(target.entry)
      .then((next) => {
        setContent(next);
      })
      .finally(() => setLoading(false));
  }, [content, loading, target.entry]);

  useEffect(() => {
    if (enabled) ensureLoaded();
  }, [enabled, ensureLoaded]);

  return { content, loading };
}
