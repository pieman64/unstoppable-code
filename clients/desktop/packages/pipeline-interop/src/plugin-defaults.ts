import {
  getShareablePluginRefKey,
  type ShareablePluginRef,
} from '@canopy/protocol/plugins';
import type { PipelinePluginDefault } from './document';

/**
 * Return the portable `ShareablePluginRef` a `PipelinePluginDefault` denotes.
 *
 * Pipeline defaults are structurally identical to `ShareablePluginRef` with
 * an optional `required` flag; this strips that flag so the ref can be fed to
 * the generic portable-ref helpers.
 */
export function getPipelinePluginDefaultRef(
  defaultRef: PipelinePluginDefault,
): ShareablePluginRef {
  if (defaultRef.type === 'skill') {
    return {
      type: 'skill',
      source: defaultRef.source,
      skill_name: defaultRef.skill_name,
    };
  }

  if (defaultRef.type === 'codex_plugin') {
    return {
      type: 'codex_plugin',
      marketplace: defaultRef.marketplace,
      plugin_name: defaultRef.plugin_name,
    };
  }

  if (defaultRef.type === 'plugin') {
    return {
      type: 'plugin',
      marketplace: defaultRef.marketplace,
      plugin_name: defaultRef.plugin_name,
    };
  }

  return {
    type: 'claude_plugin',
    marketplace: defaultRef.marketplace,
    plugin_name: defaultRef.plugin_name,
  };
}

/**
 * Return a stable, deterministic key for a `PipelinePluginDefault`.
 *
 * The key ignores the `required` flag and delegates to the portable-ref
 * keying helper.
 */
export function getPipelinePluginDefaultKey(
  defaultRef: PipelinePluginDefault,
): string {
  return getShareablePluginRefKey(getPipelinePluginDefaultRef(defaultRef));
}
