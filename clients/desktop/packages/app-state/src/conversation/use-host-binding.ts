'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type {
  ConversationPresentation,
  ConversationPresentationSource,
} from '@canopy/app-core/conversation';

export interface UseConversationHostBindingOptions {
  readonly onOpenError?: (error: unknown) => void;
}

export function useConversationHostBinding<
  View extends ConversationPresentation,
>(
  resource: ConversationPresentationSource<View>,
  options: UseConversationHostBindingOptions = {},
): View {
  const { onOpenError } = options;
  const onOpenErrorRef = useRef(onOpenError);
  useEffect(() => {
    onOpenErrorRef.current = onOpenError;
  }, [onOpenError]);
  const subscribe = useCallback(
    (listener: () => void) => resource.subscribe(listener),
    [resource],
  );
  const getSnapshot = useCallback(() => resource.getSnapshot(), [resource]);
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    let active = true;
    void resource.open().catch((error: unknown) => {
      if (active) onOpenErrorRef.current?.(error);
    });
    return (): void => {
      active = false;
      resource.close();
    };
  }, [resource]);

  return view;
}
