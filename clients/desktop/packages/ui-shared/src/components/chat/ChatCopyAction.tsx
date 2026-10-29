import {
  useCallback,
  useEffect,
  useState,
  type JSX,
  type MouseEvent,
} from 'react';
import { CheckIcon } from '../../icons/CheckIcon';
import { CopyIcon } from '../../icons/CopyIcon';
import { stripOpaqueAgentCitationMarkers } from '../../lib/agent-citations';
import {
  CLASSIC_FOOTER_ICON_BUTTON_CLASS,
  CLEAN_FOOTER_ICON_BUTTON_CLASS,
  useCleanChatLook,
} from '../chat-look';
import { useCopyToClipboard } from '../copy-to-clipboard';
import { Tooltip } from '../Tooltip';

/**
 * A message's Copy action: one quiet icon button in its action row, the same
 * size and ink as the thumbs beside it under either chat look, that turns
 * into a check for a moment after copying (CAN-4704).
 *
 * A visually hidden polite status beside the button announces `Copied`, so
 * the confirmation reaches screen readers without moving focus or folding
 * into the button's own name.
 */
interface ChatCopyActionProps {
  /** What to copy. */
  text: string;
  /** The button's name and tooltip, in sentence case. */
  label?: string;
  dataTestId?: string;
}

export function ChatCopyAction(props: ChatCopyActionProps): JSX.Element {
  // Reusing a row for different reply text must discard both feedback and
  // pending writes. Hosts also key the row/control by message identity.
  return <ChatCopyActionControl key={props.text} {...props} />;
}

function ChatCopyActionControl({
  text,
  label = 'Copy message',
  dataTestId,
}: ChatCopyActionProps): JSX.Element {
  const clean = useCleanChatLook();
  const [successCount, setSuccessCount] = useState(0);
  const [announced, setAnnounced] = useState(false);
  const handleCopied = useCallback((): void => {
    setSuccessCount((previous) => previous + 1);
  }, []);
  const { copied, copy } = useCopyToClipboard({ onCopy: handleCopied });
  useEffect((): (() => void) | undefined => {
    setAnnounced(false);
    if (!copied) return undefined;
    // Empty and refill the mounted region in separate updates, including
    // repeat copies; changing invisible whitespace is not an announcement.
    const timer = setTimeout((): void => setAnnounced(true), 100);
    return (): void => clearTimeout(timer);
  }, [copied, successCount]);
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>): void => {
      event.stopPropagation();
      // Copy what the reply shows: hidden provider citation markers stay out.
      void copy(
        stripOpaqueAgentCitationMarkers(text),
        event.currentTarget.ownerDocument,
      );
    },
    [copy, text],
  );
  const name = copied ? 'Copied' : label;
  const iconSize = clean ? '14' : '13';
  return (
    <>
      <Tooltip label={name}>
        <button
          type="button"
          onClick={handleClick}
          aria-label={name}
          data-testid={dataTestId}
          data-copied={copied ? '' : undefined}
          className={
            clean
              ? CLEAN_FOOTER_ICON_BUTTON_CLASS
              : CLASSIC_FOOTER_ICON_BUTTON_CLASS
          }
        >
          {copied ? (
            <CheckIcon width={iconSize} height={iconSize} aria-hidden="true" />
          ) : (
            <CopyIcon width={iconSize} height={iconSize} aria-hidden="true" />
          )}
        </button>
      </Tooltip>
      <span
        role="status"
        className="sr-only"
        data-testid={
          dataTestId === undefined ? undefined : `${dataTestId}-status`
        }
      >
        {copied && announced ? 'Copied' : ''}
      </span>
    </>
  );
}
