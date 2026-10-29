/**
 * Re-export of the Codex dynamic-tool content flattener, now owned by the
 * browser-safe `@canopy/agent-transcript` package (it is a dependency of the
 * shared transcript parser). Kept at this path so existing renderer importers
 * (`@/lib/codex-dynamic-tool-results`) are unchanged.
 */
export { flattenCodexDynamicToolContent } from '@canopy/agent-transcript';
