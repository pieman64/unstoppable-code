import type { JSX } from 'react';
import { CHAT_LABEL } from '@canopy/protocol';
import {
  AutoIcon,
  ChatIcon,
  TerminalBorderedIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Tooltip } from '@canopy/ui-shared';
import { useClaudeTuiChatsEnabled } from '@/lib/claude-tui-chats';
import {
  CHAT_INTERFACE_MODE_BUSY_REASONS,
  CHAT_INTERFACE_MODE_DESCRIPTIONS,
  CHAT_INTERFACE_MODE_NAMES,
  resolveChatInterfaceModeOptions,
  type ChatInterfaceModeControl,
} from './chatInterfaceModes';

/**
 * Idle-gated segmented control that switches a Claude-backed chat tab
 * between the Canopy-native chat experience, the managed Claude Code
 * terminal experience, and the hybrid "auto" mode (Canopy viewing, terminal
 * execution).
 *
 * It floats over the managed terminal surface, the way back to the chat; the
 * native composer lists the same modes in its + menu. It owns only its
 * compact 32px chrome while the caller owns placement.
 *
 * Idle-gating rules live in `resolveChatInterfaceModeOptions`, shared with
 * the composer's menu rows. The whole toggle is hidden when the active chat
 * is not Claude-backed.
 */
export interface ChatInterfaceModeToggleProps extends ChatInterfaceModeControl {
  /** Restores translucent, receding chrome when overlaid on terminal output. */
  floating?: boolean;
}

const TOOLTIP_CANOPY = CHAT_INTERFACE_MODE_NAMES.canopy;
const TOOLTIP_CLAUDE_CODE = CHAT_INTERFACE_MODE_NAMES['claude-code'];
const TOOLTIP_AUTO = `Auto: ${CHAT_INTERFACE_MODE_DESCRIPTIONS.auto}`;
const TOOLTIP_CANOPY_BUSY = CHAT_INTERFACE_MODE_BUSY_REASONS.canopyTurn;
const TOOLTIP_AUTO_BUSY = CHAT_INTERFACE_MODE_BUSY_REASONS.autoCanopyTurn;
const TOOLTIP_TERMINAL_BUSY = CHAT_INTERFACE_MODE_BUSY_REASONS.terminalTurn;

export function ChatInterfaceModeToggle({
  floating = false,
  ...control
}: ChatInterfaceModeToggleProps): JSX.Element | null {
  const claudeTuiChatsEnabled = useClaudeTuiChatsEnabled();
  if (!control.providerIsClaude || !claudeTuiChatsEnabled) {
    return null;
  }

  const [canopy, auto, claudeCode] = resolveChatInterfaceModeOptions(control);
  const onChange = control.onChange;
  const canopyDisabled = canopy?.disabled ?? false;
  const autoDisabled = auto?.disabled ?? false;
  const claudeCodeDisabled = claudeCode?.disabled ?? false;

  const baseButtonClass =
    'focus-ring relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full enabled:active:scale-97 disabled:cursor-not-allowed disabled:fg-tertiary';
  const selectedButtonClass = 'bg-transparent fg-primary';
  const unselectedButtonClass =
    'bg-transparent fg-secondary enabled:hover:bg-subtle enabled:hover:fg-primary';

  const canopyActive = canopy?.active ?? false;
  const autoActive = auto?.active ?? false;
  const claudeCodeActive = claudeCode?.active ?? false;
  const selectedIndex = canopyActive ? 0 : autoActive ? 1 : 2;

  const canopyTitle = canopy?.busyReason ?? TOOLTIP_CANOPY;
  const autoTitle = auto?.busyReason ?? TOOLTIP_AUTO;
  const claudeCodeTitle = claudeCode?.busyReason ?? TOOLTIP_CLAUDE_CODE;

  const canopyButtonClass = canopyActive
    ? selectedButtonClass
    : unselectedButtonClass;
  const autoButtonClass = autoActive
    ? selectedButtonClass
    : unselectedButtonClass;
  const claudeCodeButtonClass = claudeCodeActive
    ? selectedButtonClass
    : unselectedButtonClass;

  return (
    <div
      className={`electron-no-drag relative flex h-8 shrink-0 items-center gap-0 rounded-full p-0.5 ${
        floating
          ? 'bg-card/95 opacity-60 shadow-sm backdrop-blur hover:opacity-100 focus-within:opacity-100'
          : 'bg-muted'
      }`}
      role="group"
      aria-label={`${CHAT_LABEL} interface mode`}
      data-testid="chat-interface-mode-toggle"
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0.5 top-0.5 h-7 w-7 rounded-full bg-quaternary shadow-sm transition-[transform] duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(${selectedIndex * 28}px)` }}
        data-testid="chat-interface-mode-toggle-selector"
      />
      <Tooltip label={canopyTitle}>
        <button
          type="button"
          onClick={(): void => {
            if (canopyDisabled || canopyActive) return;
            onChange('canopy');
          }}
          aria-pressed={canopyActive}
          aria-disabled={canopyDisabled}
          aria-label={TOOLTIP_CANOPY}
          disabled={canopyDisabled}
          className={`${baseButtonClass} ${canopyButtonClass}`}
          data-testid="chat-interface-mode-toggle-canopy"
        >
          <ChatIcon size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={autoTitle}>
        <button
          type="button"
          onClick={(): void => {
            if (autoDisabled || autoActive) return;
            onChange('auto');
          }}
          aria-pressed={autoActive}
          aria-disabled={autoDisabled}
          aria-label={TOOLTIP_AUTO}
          disabled={autoDisabled}
          className={`${baseButtonClass} ${autoButtonClass}`}
          data-testid="chat-interface-mode-toggle-auto"
        >
          <AutoIcon size={16} aria-hidden="true" />
        </button>
      </Tooltip>
      <Tooltip label={claudeCodeTitle}>
        <button
          type="button"
          onClick={(): void => {
            if (claudeCodeDisabled || claudeCodeActive) return;
            onChange('claude-code');
          }}
          aria-pressed={claudeCodeActive}
          aria-disabled={claudeCodeDisabled}
          aria-label={TOOLTIP_CLAUDE_CODE}
          disabled={claudeCodeDisabled}
          className={`${baseButtonClass} ${claudeCodeButtonClass}`}
          data-testid="chat-interface-mode-toggle-claude-code"
        >
          <TerminalBorderedIcon size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    </div>
  );
}

export const CHAT_INTERFACE_MODE_TOGGLE_TOOLTIPS = {
  canopy: TOOLTIP_CANOPY,
  claudeCode: TOOLTIP_CLAUDE_CODE,
  auto: TOOLTIP_AUTO,
  canopyBusy: TOOLTIP_CANOPY_BUSY,
  autoBusy: TOOLTIP_AUTO_BUSY,
  terminalBusy: TOOLTIP_TERMINAL_BUSY,
} as const;
