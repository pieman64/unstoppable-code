import type {
  ChatInterfaceMode,
  ClaudeTerminalTurnState,
} from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';

/**
 * Everything a surface needs to offer a Claude-backed chat's interface modes:
 * the Canopy-native chat, the managed Claude Code terminal, and the hybrid
 * "auto" mode (Canopy viewing, terminal execution). The native composer lists
 * them in its + menu; the terminal surface floats `ChatInterfaceModeToggle`.
 */
export interface ChatInterfaceModeControl {
  /** Currently-selected chat-interface mode. */
  mode: ChatInterfaceMode;
  /** Called with the user's chosen mode when they pick a different option. */
  onChange: (next: ChatInterfaceMode) => void;
  /**
   * Whether the active chat tab is backed by Claude. The modes are offered
   * only for Claude-backed tabs since the managed terminal experience is
   * Claude-specific.
   */
  providerIsClaude: boolean;
  /**
   * True when a Canopy-native chat turn is currently running. Disables the
   * `Claude Code` option so the user cannot switch mid-turn.
   */
  canopyNativeBusy: boolean;
  /**
   * Latest known runtime state for the managed Claude Code terminal owned
   * by the active chat.
   */
  claudeTerminalTurnState?: ClaudeTerminalTurnState;
  /**
   * True when the managed terminal should prevent switching back to Canopy.
   * Callers pass this when they have more context than just the turn-state,
   * such as an error state that still owns a live terminal.
   */
  claudeTerminalBusy?: boolean;
}

export const CHAT_INTERFACE_MODE_NAMES: Record<ChatInterfaceMode, string> = {
  canopy: brandText.appName,
  auto: 'Auto',
  'claude-code': 'Claude Code',
};

/** What each mode does, as the + menu describes it. */
export const CHAT_INTERFACE_MODE_DESCRIPTIONS: Record<
  ChatInterfaceMode,
  string
> = {
  canopy: 'Chat view',
  auto: `${brandText.appName} viewing, terminal execution`,
  'claude-code': 'Terminal',
};

export const CHAT_INTERFACE_MODE_BUSY_REASONS = {
  canopyTurn: `Claude Code is available when the ${brandText.appName} turn is idle.`,
  autoCanopyTurn: `Auto mode is available when the ${brandText.appName} turn is idle.`,
  terminalTurn: `${brandText.appName} is available when the Claude Code turn is idle.`,
} as const;

export const CHAT_INTERFACE_MODE_ORDER: readonly ChatInterfaceMode[] = [
  'canopy',
  'auto',
  'claude-code',
];

export interface ChatInterfaceModeOption {
  mode: ChatInterfaceMode;
  active: boolean;
  disabled: boolean;
  /** Why the mode cannot be picked right now, when it is disabled. */
  busyReason?: string;
}

/**
 * The idle-gating rules (Frontend plan §F3), shared by every surface that
 * offers the modes:
 *   - `Auto` and `Claude Code` are unavailable while a Canopy-native turn is
 *     streaming.
 *   - `Canopy` is unavailable while the managed terminal runtime is not idle,
 *     or while its own turn streams.
 */
export function resolveChatInterfaceModeOptions(
  control: ChatInterfaceModeControl,
): ChatInterfaceModeOption[] {
  const {
    mode,
    canopyNativeBusy,
    claudeTerminalTurnState,
    claudeTerminalBusy,
  } = control;
  const terminalBusy =
    claudeTerminalBusy ??
    (claudeTerminalTurnState === 'starting' ||
      claudeTerminalTurnState === 'running' ||
      claudeTerminalTurnState === 'cleaning_up');
  const canopyTurnBusy = mode === 'canopy' && canopyNativeBusy;
  return CHAT_INTERFACE_MODE_ORDER.map((option): ChatInterfaceModeOption => {
    if (option === 'canopy') {
      const disabled = terminalBusy || canopyTurnBusy;
      return {
        mode: option,
        active: mode === option,
        disabled,
        ...(disabled
          ? {
              busyReason: terminalBusy
                ? CHAT_INTERFACE_MODE_BUSY_REASONS.terminalTurn
                : CHAT_INTERFACE_MODE_BUSY_REASONS.canopyTurn,
            }
          : {}),
      };
    }
    return {
      mode: option,
      active: mode === option,
      disabled: canopyNativeBusy,
      ...(canopyNativeBusy
        ? {
            busyReason:
              option === 'auto'
                ? CHAT_INTERFACE_MODE_BUSY_REASONS.autoCanopyTurn
                : CHAT_INTERFACE_MODE_BUSY_REASONS.canopyTurn,
          }
        : {}),
    };
  });
}
