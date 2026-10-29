/**
 * `@canopy/agent-transcript` — browser-safe, protocol-only home for the agent
 * transcript types, the provider-JSONL parser, and the Portal chat projection.
 *
 * Shared by the desktop app (renderer transcript parser, desktop-shared portal
 * projection, both of which re-export from here) and the hosted web run viewer
 * (`apps/web`, which cannot import `@canopy/desktop-shared`). Keep this package
 * free of Node, Electron, Prisma, Next, React, and Zustand imports; it may
 * depend only on `@canopy/protocol` wire types.
 */
export * from './types';
export * from './lib/delegation-transcript';
export * from './lib/transcript-parser';
export * from './lib/todo-parser';
export * from './lib/codex-dynamic-tool-results';
export * from './lib/codex-mcp-tool-results';
export * from './lib/provider-errors';
export * from './lib/epoch-ms';
export * from './lib/auth-failure-attach';
export * from './lib/memory-citation';
export * from './lib/handoff-summary';
export * from './lib/message-sanitization';
export * from './lib/hidden-message-content';
export * from './lib/transcript-fingerprint';
export * from './lib/subagent-tree';
export * from './lib/visual-ref';
export * from './lib/subagent-chat-transcript';
export {
  setTranscriptModelResolver,
  type TranscriptModelResolver,
} from './lib/model-resolver';
export * from './portal/persisted-chat-projection';
export { portalPartHasVisual } from './portal/portal-part-visual';
export {
  portalChatAttachmentPaths,
  portalChatAttachmentIdForPath,
  portalChatMessageAttachmentsFromPaths,
} from './portal/message-attachments';
