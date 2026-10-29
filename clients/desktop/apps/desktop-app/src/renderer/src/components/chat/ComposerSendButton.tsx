import type { JSX } from 'react';
import { TerminalRunButton, Tooltip } from '@canopy/ui-shared';
import { ArrowUp, StopFilledIcon } from '@canopy/ui-shared/icons/AppIcons';
import { LoadingSpinner } from '@/components/shared/loading/spinners/LoadingSpinner';

/**
 * The composer's trailing action, by priority:
 * 1. Terminal mode: run the command (works while streaming too; the command
 *    runs in a new PTY and bypasses the chat queue).
 * 2. Streaming: stop the turn. Typing still queues a follow-up via Enter.
 * 3. Idle: send.
 * A pending model change disables stop and send and shows a spinner.
 */
export type ComposerSendButtonProps =
  | {
      kind: 'terminal';
      onRun: () => void;
      /** No command typed yet. */
      disabled: boolean;
      /** The last command could not be sent: red rather than warning. */
      failed?: boolean;
    }
  | {
      kind: 'stop';
      onStop: () => void;
      /** A model change is being applied; stopping waits for it. */
      pending: boolean;
      /** The first Esc armed the stop; the next press confirms it. */
      armed: boolean;
      /** Esc can stop this turn from the composer. */
      shortcutReady: boolean;
    }
  | {
      kind: 'send';
      onSend: () => void;
      /** Nothing to send, or sending is blocked. */
      disabled: boolean;
      /** A model change is being applied; sending waits for it. */
      pending: boolean;
      /** Why sending is blocked, shown in the tooltip. */
      blockedReason?: string;
      dataTestId?: string;
    };

export function ComposerSendButton(
  props: ComposerSendButtonProps,
): JSX.Element {
  if (props.kind === 'terminal') {
    // The shared run button: send's recipe on the warning surface that marks
    // terminal mode; destructive while the last command could not be sent.
    return (
      <TerminalRunButton
        onRun={props.onRun}
        disabled={props.disabled}
        failed={props.failed === true}
      />
    );
  }

  if (props.kind === 'stop') {
    const { onStop, pending, armed, shortcutReady } = props;
    const showArmed = armed && !pending;
    return (
      <Tooltip
        label={
          pending
            ? 'Updating model'
            : armed
              ? 'Press Esc again to stop'
              : 'Stop generation'
        }
      >
        <button
          type="button"
          onClick={onStop}
          data-testid="chat-stop-generation"
          disabled={pending}
          aria-busy={pending}
          data-cancel-shortcut-ready={shortcutReady || undefined}
          data-cancel-armed={armed || undefined}
          // The primary action while a turn runs, in send's own recipe; armed,
          // it widens into the shared md capsule's padding, gap, and label.
          className={
            showArmed
              ? 'focus-ring flex h-8 items-center justify-center gap-1.5 rounded-full bg-accent px-3 fg-emphasis transition enabled:hover:bg-accent/90 enabled:active:scale-97 disabled:cursor-not-allowed disabled:opacity-40'
              : 'focus-ring flex h-8 w-8 items-center justify-center rounded-full bg-accent fg-emphasis transition enabled:hover:bg-accent/90 enabled:active:scale-97 disabled:cursor-not-allowed disabled:opacity-40'
          }
          aria-label={showArmed ? 'Press Esc again to stop' : 'Stop generation'}
        >
          {pending ? (
            <LoadingSpinner dataTestId="chat-model-change-pending" decorative />
          ) : (
            <>
              <StopFilledIcon size={16} />
              {showArmed && (
                <span className="text-s font-medium leading-none">Esc</span>
              )}
            </>
          )}
        </button>
      </Tooltip>
    );
  }

  const { onSend, disabled, pending, blockedReason, dataTestId } = props;
  return (
    // While sending is blocked, the tooltip carries the reason so a disabled
    // send explains itself.
    // Ready to send, the tooltip names the action and its key; blocked or
    // pending, it says why instead.
    <Tooltip
      label={blockedReason ?? (pending ? 'Updating model' : 'Send')}
      {...(blockedReason || pending ? {} : { shortcut: '↵' })}
    >
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || pending}
        className="focus-ring inline-flex h-8 w-8 items-center justify-center rounded-full bg-accent fg-emphasis transition enabled:hover:bg-accent/90 enabled:active:scale-97 disabled:cursor-not-allowed disabled:bg-muted disabled:fg-tertiary disabled:opacity-100"
        aria-label="Send message"
        aria-busy={pending}
        data-testid={dataTestId}
      >
        {pending ? (
          <LoadingSpinner dataTestId="chat-model-change-pending" decorative />
        ) : (
          <ArrowUp width={16} height={16} />
        )}
      </button>
    </Tooltip>
  );
}
