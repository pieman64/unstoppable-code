import {
  getPipelinePluginDefaultRef,
  getPipelinePluginDefaultKey,
} from '@canopy/pipeline-interop/plugin-defaults';
export {
  getPipelinePluginDefaultRef,
  getPipelinePluginDefaultKey,
} from '@canopy/pipeline-interop/plugin-defaults';
// ---------------------------------------------------------------------------
// Pipeline plugin-collection helpers (transport layer)
//
// These helpers serialize and display pipeline plugin-collection defaults and
// preference locators. They live next to the pipeline subsystem because they
// are collection-specific; the generic portable-ref helpers live in
// `src/shared/plugin-refs.ts` and are reused across features.
// ---------------------------------------------------------------------------

import { buildShareablePluginDisplay } from '../plugin-refs';
import type {
  Pipeline,
  PipelinePluginDefault,
  PipelinePreferenceLocator,
} from '../types/pipeline';

/**
 * One capability reference declared by a pipeline's `plugin_collections`,
 * annotated with the collection it came from so consumers can explain the
 * relationship ("used by collection X"). Deduplicated by portable-ref key.
 */
export interface PipelineCapabilityRef {
  /** Stable portable-ref key (`getPipelinePluginDefaultKey`). */
  key: string;
  kind: 'skill' | 'plugin';
  /** True when any declaring collection marks the ref required. */
  required: boolean;
  collectionId: string;
  collectionName: string;
  defaultRef: PipelinePluginDefault;
}

/**
 * Collect the capability refs a pipeline declares through
 * `plugin_collections[].defaults[]` — the only structured skill/plugin
 * linkage in a pipeline definition. Refs are deduplicated by portable-ref
 * key; `required` is true when any occurrence is required, and attribution
 * belongs to the first collection that requires the ref (or the first
 * declaring collection when none do). Malformed refs are skipped.
 */
export function collectPipelineCapabilityRefs(
  pipeline: Pick<Pipeline, 'plugin_collections'>,
): PipelineCapabilityRef[] {
  const byKey = new Map<string, PipelineCapabilityRef>();
  for (const collection of pipeline.plugin_collections ?? []) {
    for (const defaultRef of collection.defaults ?? []) {
      let key: string;
      try {
        key = getPipelinePluginDefaultKey(defaultRef);
      } catch {
        continue;
      }
      const existing = byKey.get(key);
      if (existing) {
        // A later collection upgrading the ref to required also takes over
        // the attribution: "Required by <collection>" must name the
        // collection that actually requires it.
        if (defaultRef.required === true && !existing.required) {
          existing.required = true;
          existing.collectionId = collection.id;
          existing.collectionName = collection.name;
        }
        continue;
      }
      byKey.set(key, {
        key,
        kind: defaultRef.type === 'skill' ? 'skill' : 'plugin',
        required: defaultRef.required === true,
        collectionId: collection.id,
        collectionName: collection.name,
        defaultRef,
      });
    }
  }
  return Array.from(byKey.values());
}

/**
 * Serialize a `PipelinePreferenceLocator` to its canonical string form.
 *
 * Examples:
 *   { type: 'stored', source: 'bundled', value: 'plan-review' }
 *     -> "stored:bundled:plan-review"
 *   { type: 'stored', source: 'user', value: 'plan-review' }
 *     -> "stored:user:plan-review"
 *   { type: 'file', value: '/abs/foo.yaml' } -> "file:/abs/foo.yaml"
 *   { type: 'shared', value: 'srv-uuid:pipeline-uuid' }
 *     -> "shared:srv-uuid:pipeline-uuid"
 *
 * Used as the entry key in the local preference store and as the wire form
 * for any consumer that needs a single-string representation of a locator.
 *
 * Note: the `shared` variant's `value` is itself a compound key
 * (`${serverId}:${remoteId}`), which produces a serialized form with two
 * colons. Consumers must split with `indexOf(':')` to take the type prefix
 * and treat the remainder as the opaque `value`.
 */
export function serializePipelinePreferenceLocator(
  locator: PipelinePreferenceLocator,
): string {
  if (locator.type === 'stored') {
    return `${locator.type}:${locator.source}:${locator.value}`;
  }
  return `${locator.type}:${locator.value}`;
}

/**
 * Return the user-facing display strings for a pipeline plugin default.
 * Wraps `buildShareablePluginDisplay` so callers don't have to strip the
 * `required` flag before rendering.
 */
export function buildPipelineDefaultDisplay(
  defaultRef: PipelinePluginDefault,
): { title: string; subtitle: string } {
  return buildShareablePluginDisplay(getPipelinePluginDefaultRef(defaultRef));
}
