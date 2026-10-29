import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import {
  CHAT_CUSTOM_TITLE_MAX_LENGTH,
  CHAT_UNIT_LABEL,
} from '@canopy/protocol';
import { useShallow } from 'zustand/react/shallow';
import { RenameDialog } from '@canopy/ui-shared/components';
import { useChatStore } from '@/stores/chatStore';
import { useWorkspaceIsReadOnly } from '@/lib/workspace-access';
import {
  generatedChatTabLabel,
  normalizeChatCustomTitle,
} from '@/lib/chatTabLabel';

/** The chat a rename dialog edits, captured when the dialog opens. */
export interface ChatTabRenameTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly tabId: string;
  readonly ownerDocument?: Document;
  /** The tab element to refocus on close, when the host knows it. */
  readonly returnFocusElement?: HTMLElement | null;
}

/** Restore focus to the originating chat tab if it is still on screen. */
function tabFocusFallback(
  target: ChatTabRenameTarget,
): RefObject<HTMLElement | null> {
  return {
    get current(): HTMLElement | null {
      const doc = target.ownerDocument ?? document;
      const candidates = [
        target.returnFocusElement,
        doc.querySelector<HTMLElement>(
          `[data-testid=${JSON.stringify(`chat-tab-${target.tabId}`)}]`,
        ),
        doc.querySelector<HTMLElement>(
          `[data-testid=${JSON.stringify(`panel-tab-panel-chat-${target.tabId}`)}]`,
        ),
        doc.querySelector<HTMLElement>('[role="tab"][data-active="true"]'),
        doc.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'),
      ];
      // Panel tabs are adopted from the opener into auxiliary documents;
      // their constructor realm can differ from their current ownerDocument.
      for (const candidate of candidates) {
        if (
          candidate !== null &&
          candidate !== undefined &&
          candidate.ownerDocument === doc &&
          candidate.isConnected
        ) {
          return candidate;
        }
      }
      return null;
    },
  };
}

function ChatTabRenameDialog({
  target,
  onClose,
}: {
  target: ChatTabRenameTarget;
  onClose: () => void;
}): JSX.Element | null {
  const key = `${target.projectId}/${target.worktreeId}`;
  const readOnly = useWorkspaceIsReadOnly();
  // Primitive fields only, so a streaming reply does not re-render the dialog.
  const tab = useChatStore(
    useShallow((state) => {
      const found = state.worktreeChats[key]?.tabs.find(
        (t) => t.id === target.tabId,
      );
      const phase = state.chatStateSync[key]?.phase;
      return readOnly ||
        (phase !== undefined && phase !== 'live') ||
        found === undefined ||
        found.kind === 'file'
        ? null
        : {
            title: found.title,
            description: found.description,
            customTitle: found.customTitle,
          };
    }),
  );
  const renameTab = useChatStore((state) => state.renameTab);
  const [busy, setBusy] = useState(false);
  const submittingRef = useRef(false);
  // The draft is read once on open; later title updates only refresh the
  // placeholder.
  const [initialValue] = useState(() => tab?.customTitle ?? '');
  const restoreFocusRef = useMemo(() => tabFocusFallback(target), [target]);
  const available = tab !== null;

  useEffect(() => {
    if (!available && !submittingRef.current) onClose();
  }, [available, onClose]);

  const handleSubmit = useCallback(
    (value: string): void => {
      if (submittingRef.current || !available) return;
      const normalized = normalizeChatCustomTitle(value);
      if (normalized === undefined) return;
      if (normalized === (tab?.customTitle ?? null)) {
        onClose();
        return;
      }
      submittingRef.current = true;
      setBusy(true);
      // Failures surface through the chat-state notice and canonical refresh.
      void renameTab(target.tabId, normalized, {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
      }).finally(onClose);
    },
    [available, onClose, renameTab, tab?.customTitle, target],
  );

  if (tab === null) return null;
  return (
    <RenameDialog
      title={`Rename ${CHAT_UNIT_LABEL}`}
      label="Name"
      initialValue={initialValue}
      placeholder={generatedChatTabLabel(tab)}
      helperText="Leave empty to use the generated name."
      maxLength={CHAT_CUSTOM_TITLE_MAX_LENGTH}
      busy={busy}
      onSubmit={handleSubmit}
      onClose={onClose}
      ownerDocument={target.ownerDocument}
      restoreFocusRef={restoreFocusRef}
      dataTestId="chat-tab-rename-dialog"
      inputTestId="chat-tab-rename-input"
      submitTestId="chat-tab-rename-save"
      cancelTestId="chat-tab-rename-cancel"
    />
  );
}

/**
 * Rename state for a chat tab host: `open` captures the target, and `dialog`
 * renders the shared rename dialog for it.
 */
export function useChatTabRename(): {
  open: (target: ChatTabRenameTarget) => void;
  dialog: JSX.Element | null;
} {
  const [target, setTarget] = useState<ChatTabRenameTarget | null>(null);
  const close = useCallback((): void => setTarget(null), []);
  const dialog =
    target === null ? null : (
      <ChatTabRenameDialog
        key={`${target.projectId}/${target.worktreeId}/${target.tabId}`}
        target={target}
        onClose={close}
      />
    );
  return { open: setTarget, dialog };
}
