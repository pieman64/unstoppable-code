/**
 * Desktop-renderer transcript parser.
 *
 * The parser core, reducer, and transcript types now live in the browser-safe
 * `@canopy/agent-transcript` package so the hosted web run viewer (CAN-396) can
 * reuse the exact same projection. This module is the thin desktop adapter over
 * that package: it injects the desktop's full-fidelity model resolver and adds
 * the renderer-only display-message shaping (`mergeToolResults` /
 * `reorderMessagesForDisplay`) that depends on renderer components and so cannot
 * live in the neutral package.
 */
import {
  parseAgentTranscriptLines as parseAgentTranscriptLinesCore,
  setTranscriptModelResolver,
  type ParsedTranscript as CoreParsedTranscript,
  type TranscriptParseOptions,
} from '@canopy/agent-transcript';
import type {
  AgentProviderType,
  AgentUsage,
} from '@canopy/desktop-shared/types';
import {
  getEffectiveModelContextWindow,
  getModelContextWindow,
  getModelDisplayName,
  resolveKnownModel,
  resolveModelAlias,
  resolveRuntimeModel,
} from '@canopy/desktop-shared/types';
import {
  mergeToolResults,
  reorderMessagesForDisplay,
} from '@/components/chat/message-transforms';
import type { DisplayMessage } from '@/components/chat/types';
import type { ChatMessage } from '@/stores/chatStore';

export {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  deriveCurrentTaskTodosFromMessages,
  deriveCurrentTodosFromMessages,
  pauseOpenTurnTimer,
  pauseTurnTimerBlock,
  resumePausedTurnTimer,
  resumeTurnTimerBlock,
  type TranscriptParseOptions,
  type TranscriptReducerOptions,
  type TranscriptReducerState,
} from '@canopy/agent-transcript';

// Inject the desktop's real model metadata (populated from package.json via
// `initModelAliases`) so model-change markers and context-window tracking keep
// full fidelity. Hosts that never import this module (e.g. the web run viewer)
// fall back to the package's identity resolver. Idempotent module-load effect.
setTranscriptModelResolver({
  resolveModelAlias,
  resolveKnownModel,
  resolveRuntimeModel,
  getModelDisplayName,
  getModelContextWindow: (model, aiCreditsRouted) =>
    aiCreditsRouted
      ? getEffectiveModelContextWindow(model, true)
      : getModelContextWindow(model),
});

/**
 * Renderer parse result: the neutral core plus the renderer-only
 * `displayMessages` shaping used by the chat/activity views.
 */
export interface ParsedTranscript extends CoreParsedTranscript {
  displayMessages: DisplayMessage[];
}

export function buildTranscriptDisplayMessages(
  messages: ChatMessage[],
  agentUsage?: Record<string, AgentUsage>,
): DisplayMessage[] {
  return mergeToolResults(reorderMessagesForDisplay(messages), agentUsage);
}

export function parseAgentTranscriptLines(
  lines: string[],
  preferredProvider?: AgentProviderType,
  parseOptions: TranscriptParseOptions = {},
): ParsedTranscript {
  const core = parseAgentTranscriptLinesCore(
    lines,
    preferredProvider,
    parseOptions,
  );
  return {
    ...core,
    displayMessages: buildTranscriptDisplayMessages(
      core.messages,
      core.agentUsage,
    ),
  };
}
