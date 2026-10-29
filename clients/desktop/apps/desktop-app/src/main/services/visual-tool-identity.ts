import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import {
  cursorCanopyMcpServerNames,
  parseCursorMcpToolCall,
  resolveCursorCanopyToolKey,
  type CursorCanopyServerMode,
  type CursorCanopyToolSurface,
} from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import type { CursorToolInvocation } from '@canopy/desktop-shared/node/cursor/events';

export interface VisualToolTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface TurnVisualLedger {
  record(toolUseId: string): void;
  forget(toolUseId: string): void;
  close(): void;
}

interface LedgerEntry {
  targetKey: string;
  toolUseIds: Set<string>;
}

const MAX_OPEN_TURNS = 128;
const MAX_IDS_PER_TURN = 1_024;
const openLedgers = new Map<number, LedgerEntry>();
let nextLedgerId = 0;

function targetKey(target: VisualToolTarget): string {
  return JSON.stringify([target.projectId, target.worktreeId, target.chatId]);
}

/** Open one Cursor turn's trusted invocation ledger. Close after its final drain. */
export function openTurnLedger(target: VisualToolTarget): TurnVisualLedger {
  const id = ++nextLedgerId;
  const entry: LedgerEntry = {
    targetKey: targetKey(target),
    toolUseIds: new Set(),
  };
  openLedgers.set(id, entry);
  if (openLedgers.size > MAX_OPEN_TURNS) {
    const oldest = openLedgers.keys().next().value;
    if (oldest !== undefined) openLedgers.delete(oldest);
  }
  return {
    record(toolUseId: string): void {
      if (!toolUseId || openLedgers.get(id) !== entry) return;
      entry.toolUseIds.delete(toolUseId);
      entry.toolUseIds.add(toolUseId);
      if (entry.toolUseIds.size > MAX_IDS_PER_TURN) {
        const oldest = entry.toolUseIds.values().next().value;
        if (oldest !== undefined) entry.toolUseIds.delete(oldest);
      }
    },
    forget(toolUseId: string): void {
      entry.toolUseIds.delete(toolUseId);
    },
    close(): void {
      openLedgers.delete(id);
      entry.toolUseIds.clear();
    },
  };
}

/** Admit only a UUID recorded by an open turn for this exact chat scope. */
export function hasTrustedVisualToolUse(
  target: VisualToolTarget,
  toolUseId: string,
): boolean {
  if (!toolUseId) return false;
  const key = targetKey(target);
  let found = false;
  openLedgers.forEach((entry: LedgerEntry): void => {
    if (entry.targetKey === key && entry.toolUseIds.has(toolUseId))
      found = true;
  });
  return found;
}

/** Admit only a structured call to this turn's configured main app server. */
export function isTrustedCursorShowVisualInvocation(
  invocation: CursorToolInvocation,
  context: {
    serverMode: CursorCanopyServerMode;
    appToolsReachedCli: boolean;
    toolSurface: CursorCanopyToolSurface;
  },
): boolean {
  const { rawInput, title, kind } = invocation;
  if (
    context.serverMode !== 'default' ||
    !context.appToolsReachedCli ||
    typeof rawInput !== 'object' ||
    rawInput === null ||
    Array.isArray(rawInput) ||
    !('providerIdentifier' in rawInput) ||
    rawInput.providerIdentifier !== cursorCanopyMcpServerNames().main ||
    !('toolName' in rawInput) ||
    rawInput.toolName !== CANOPY_INJECTED_TOOL_REGISTRY.show_visual.displayName
  )
    return false;
  const call = parseCursorMcpToolCall({ title, rawInput, kind });
  return (
    call !== null &&
    resolveCursorCanopyToolKey(call, context.toolSurface) === 'show_visual'
  );
}
