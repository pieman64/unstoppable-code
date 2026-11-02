/**
 * Main-process compatibility facade for the browser-safe chat projectors.
 * Electron main and renderer must consume the same whole-message projection so
 * their canonical message ids and turn lifecycle cannot drift.
 */
export {
  PORTAL_CHAT_SEED_MESSAGE_LIMIT,
  PORTAL_CHAT_TRANSCRIPT_MESSAGE_LIMIT,
  limitPortalChatTranscript,
  limitPortalChatTranscriptForSeed,
  limitPortalChatTranscriptForSeedWithMetadata,
  portalChatMessageAttachmentsFromPaths,
  type PortalChatTranscriptSeed,
  persistedMessageToPortalMessage,
  persistedParts,
  projectPersistedChatTranscript,
  turnTimerAutoRoutedModelData,
} from '@canopy/desktop-shared/portal/persisted-chat-projection';
export {
  createCursorAssistantPatchProjector,
  isCursorAssistantPatchEvent,
  isTerminalRuntimeChatEvent,
  projectCanonicalPortalTurnTimers,
  runtimeChatEventToPortalMessage,
  type CursorAssistantPatchProjector,
} from '@canopy/desktop-shared/portal/runtime-chat-projection';
