import type { RuntimeToolAdmission } from '@canopy/desktop-shared/portal/runtime-chat-projection';
import {
  PRIMARY_TOOL_CORRELATION_MAX_BYTES,
  PRIMARY_TOOL_CORRELATION_MAX_ENTRIES,
  type ProviderEventAdmission,
  type ToolOccurrenceAdmission,
} from '../services/provider-event-admission';

type RetainedTool = ToolOccurrenceAdmission & { readonly revision: number };

export interface PortalPrimaryToolCorrelation {
  /** The key is the visible provider message, never its tool id. */
  retain(messageId: string, admission: ProviderEventAdmission): void;
  forMessage(messageId: string): RuntimeToolAdmission | undefined;
  /** Eviction never transfers a source position to another message. */
  forget(messageId: string): void;
  /** Dispatch owners must call on settlement and turn/provider replacement. */
  clear(): void;
}

/** One instance per dispatched turn. No fallback provider-tool-id index. */
export function createPortalPrimaryToolCorrelation(
  onLimit?: (reason: 'entries' | 'bytes') => void,
): PortalPrimaryToolCorrelation {
  const entries = new Map<
    string,
    { messageId: string; tool: RetainedTool; bytes: number }
  >();
  let bytes = 2;
  let limited = false;
  let owner: string | undefined;
  const clear = (): void => {
    entries.clear();
    bytes = 2;
    limited = false;
    owner = undefined;
  };
  return {
    retain(messageId, admission): void {
      const identity = JSON.stringify([
        admission.projectId,
        admission.worktreeId,
        admission.chatId,
        admission.turnUserMessageId,
      ]);
      if (owner !== undefined && owner !== identity) clear();
      owner = identity;
      for (const tool of admission.tools) {
        const key = JSON.stringify([messageId, tool.sourceToken]);
        const previous = entries.get(key);
        const retained = { ...tool, revision: admission.revision };
        const entryBytes =
          Buffer.byteLength(
            JSON.stringify([key, messageId, retained]),
            'utf8',
          ) + 1;
        const nextBytes = bytes - (previous?.bytes ?? 0) + entryBytes;
        const reason =
          !previous && entries.size >= PRIMARY_TOOL_CORRELATION_MAX_ENTRIES
            ? 'entries'
            : nextBytes > PRIMARY_TOOL_CORRELATION_MAX_BYTES
              ? 'bytes'
              : undefined;
        if (reason) {
          // A rejected replacement must not leave the old position stampable.
          if (previous) {
            entries.delete(key);
            bytes -= previous.bytes;
          }
          if (!limited) {
            limited = true;
            onLimit?.(reason);
          }
          break;
        }
        entries.set(key, { messageId, tool: retained, bytes: entryBytes });
        bytes = nextBytes;
      }
    },
    forMessage(messageId): RuntimeToolAdmission | undefined {
      const tools = Array.from(entries.values())
        .filter((entry) => entry.messageId === messageId)
        .map((entry) => entry.tool);
      return tools.length ? { revision: 0, tools } : undefined;
    },
    forget(messageId): void {
      entries.forEach((entry, key): void => {
        if (entry.messageId !== messageId) return;
        entries.delete(key);
        bytes -= entry.bytes;
      });
    },
    clear,
  };
}
