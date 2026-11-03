import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type JSX,
} from 'react';
import { AppAdvisorIcon } from '@canopy/ui-shared/icons';
import { Button, DialogModal } from '@canopy/ui-shared/components';
import { ArrowUp as AppCatalogArrowUp } from '@canopy/ui-shared/icons/AppIcons';
import {
  SlateEditor,
  createChatEditor,
  createEmptyValue,
  serializeEditorValue,
  type SlateEditorHandle,
} from '@canopy/ui-rich/editor';
import { ErrorBanner } from '@canopy/ui-shared/components';

interface AppAdvisorQuickPromptModalProps {
  onClose: () => void;
}

export function AppAdvisorQuickPromptModal({
  onClose,
}: AppAdvisorQuickPromptModalProps): JSX.Element {
  const editor = useMemo(() => createChatEditor(), []);
  const [value, setValue] = useState(createEmptyValue);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editorRef = useRef<SlateEditorHandle | null>(null);
  const promptText = useMemo(
    () => serializeEditorValue(value).text.trim(),
    [value],
  );

  useEffect(() => {
    requestAnimationFrame(() => editorRef.current?.focus());
  }, []);

  const sendPrompt = async (): Promise<void> => {
    if (sending) return;
    if (!promptText) return;

    setSending(true);
    setError(null);
    try {
      await window.api.appAdvisor.ensureWindow({ quickPrompt: promptText });
      onClose();
    } catch (sendError) {
      setError(
        sendError instanceof Error
          ? sendError.message
          : 'Failed to send quick prompt.',
      );
      setSending(false);
    }
  };

  // Escape belongs to the dialog.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendPrompt();
    }
  }

  return (
    // The card records; `SlateEditor` blocks the prompt draft itself.
    <DialogModal
      onClose={onClose}
      placement="top"
      maxWidth="xl"
      inset="flush"
      titleId="app-advisor-quick-prompt-title"
      title={
        <span
          className="flex items-center gap-2"
          data-testid="app-advisor-quick-prompt-header"
        >
          <AppAdvisorIcon className="h-4 w-4 fg-primary" />
          {ORCHESTRATOR_LABEL}
        </span>
      }
      dataTestId="app-advisor-quick-prompt"
    >
      <div className="relative">
        <SlateEditor
          ref={editorRef}
          editor={editor}
          value={value}
          onChange={setValue}
          onKeyDown={handleKeyDown}
          placeholder={`Ask ${ORCHESTRATOR_LABEL}…`}
          containerClassName="min-h-33 max-h-65 cursor-text overflow-y-auto px-6 py-3"
          editableClassName="min-h-27 whitespace-pre-wrap break-words bg-transparent pr-16 text-s leading-5 fg-primary outline-none placeholder:fg-secondary"
          dataTestId="app-advisor-quick-prompt-editor"
        />
        <span className="absolute bottom-3 right-3 flex">
          <Button
            size="compact"
            iconOnly
            onClick={() => void sendPrompt()}
            disabled={sending || !promptText}
            aria-label={`Send ${ORCHESTRATOR_LABEL} prompt`}
          >
            <AppCatalogArrowUp width="14" height="14" />
          </Button>
        </span>
      </div>
      <ErrorBanner error={error} className="mx-6 mb-3" />
    </DialogModal>
  );
}
