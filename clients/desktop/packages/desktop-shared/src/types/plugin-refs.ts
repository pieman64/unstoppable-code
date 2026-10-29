// ---------------------------------------------------------------------------
// Portable plugin-ref types.
//
// The wire shapes for shareable plugin/skill refs live in `@canopy/protocol`
// so the web app and the desktop app agree on the same data model. This file
// re-exports them so existing imports of
// `@canopy/desktop-shared/types/plugin-refs` keep working unchanged.
//
// Do NOT redefine these shapes locally — the protocol package is the single
// source of truth.
// ---------------------------------------------------------------------------

export type {
  ShareableBuiltinSource,
  ShareableClaudePluginRef,
  ShareableCodexBuiltinMarketplaceSource,
  ShareableCodexPluginRef,
  ShareableCodexPluginSource,
  ShareableDynamicPluginRef,
  ShareableGitHubSource,
  ShareablePluginRef,
  ShareablePluginSource,
  ShareableSkillRef,
} from '@canopy/protocol/plugins';
