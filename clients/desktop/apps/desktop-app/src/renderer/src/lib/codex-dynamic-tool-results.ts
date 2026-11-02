/**
 * Re-export of the Codex dynamic-tool content preview helper, now owned by the
 * browser-safe `@canopy/agent-transcript` package (it is a dependency of the
 * shared transcript parser). Kept at this path so existing renderer importers
 * (`@/lib/codex-dynamic-tool-results`) are unchanged.
 */
export { previewCodexDynamicToolContent } from '@canopy/agent-transcript';
