import { useEffect, useRef } from 'react';
import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';

/**
 * Register a component-local slice into the renderer's current-UI-state
 * envelope so the App Advisor can read it as part of its sanitized hidden
 * context.
 *
 * Keys are namespaced; the snapshot builder reads them under fixed names
 * (e.g. `pipelineRuns.detailModal`, `terminal.drawer`). Passing a `null`
 * value (or unmounting the component) clears the slice this instance wrote.
 * A `null` key reports nothing.
 *
 * Only the instance that wrote the slice's current value owns it. An instance
 * that never reported (for example an inline or archived pipeline detail
 * that shares a component with the reporting one), or whose value has since
 * been replaced by another instance, never clears the key on unmount or when
 * its own value becomes `null`.
 *
 * The hook is intentionally lightweight: it `JSON.stringify`s the supplied
 * value to detect changes, so callers can pass plain objects without
 * memoizing them. For large or hot-path slices, memoize at the call site to
 * avoid re-serialization.
 */
export function useCurrentUiStateReporter(
  key: string | null,
  value: AppAdvisorJson | null,
): void {
  const lastSerializedRef = useRef<string | null>(null);
  // The exact value this instance last wrote under `key`; the store keeps it
  // by reference, so identity tells whether this instance still owns the key.
  const writtenRef = useRef<{ key: string; value: AppAdvisorJson } | null>(
    null,
  );

  useEffect(() => {
    if (key === null) return;
    const serialized = value === null ? null : JSON.stringify(value);
    if (serialized === lastSerializedRef.current) {
      return;
    }
    lastSerializedRef.current = serialized;
    const store = useCurrentUiStateStore.getState();
    if (value === null) {
      releaseOwnedSlice(writtenRef.current);
      writtenRef.current = null;
      return;
    }
    store.updateSlice(key, value);
    writtenRef.current = { key, value };
  }, [key, value]);

  useEffect(() => {
    // On unmount or key change, clear the slice this instance still owns so
    // stale state from torn-down components does not leak into the App
    // Advisor context, without clearing another instance's value.
    return (): void => {
      lastSerializedRef.current = null;
      releaseOwnedSlice(writtenRef.current);
      writtenRef.current = null;
    };
  }, [key]);
}

function releaseOwnedSlice(
  written: { key: string; value: AppAdvisorJson } | null,
): void {
  if (written === null) return;
  const store = useCurrentUiStateStore.getState();
  if (store.slices[written.key] === written.value) {
    store.updateSlice(written.key, null);
  }
}
