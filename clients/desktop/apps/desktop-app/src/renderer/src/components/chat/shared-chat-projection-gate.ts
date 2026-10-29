/**
 * Gate for `DesktopSharedChatPanelBridge`'s transcript projection into the
 * shared `@canopy/app-state` chat store.
 *
 * Nothing on the desktop host renders that store's transcript: the shared
 * `ChatPanel` hands its thread to the host's `renderTranscript` and
 * `renderComposer` callbacks, and both desktop callbacks ignore it. While
 * the gate is off the bridge neither re-projects the transcript nor
 * re-hydrates the shared thread on transcript changes; it still hydrates the
 * thread's status, route and settings.
 *
 * Before anything reads the shared thread's messages on desktop, make the
 * projection incremental and turn this on.
 * `__tests__/WorktreeChatSurface.shared-projection-gate.test.tsx` fails if a
 * new reader appears while the gate is off.
 */
export const SHARED_CHAT_TRANSCRIPT_PROJECTION_ENABLED: boolean = false;
