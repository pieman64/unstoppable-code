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
import { Button } from '@canopy/ui-shared/components';
import { ArrowUp as AppCatalogArrowUp } from '@canopy/ui-shared/icons/AppIcons';
import {
  SlateEditor,
  createChatEditor,
  createEmptyValue,
  serializeEditorValue,
  type SlateEditorHandle,
} from '@canopy/ui-rich/editor';

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

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendPrompt();
    }
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-start justify-center bg-overlay-scrim px-4 pt-[18vh]"
      onClick={onClose}
    >
      {/* The card records; `SlateEditor` blocks the prompt draft itself. */}
      <section
        role="dialog"
        aria-modal="true"
        aria-label={`${ORCHESTRATOR_LABEL} quick prompt`}
        data-testid="app-advisor-quick-prompt"
        className="electron-no-drag flex w-full max-w-152 flex-col overflow-hidden rounded-lg bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="electron-drag flex h-10 items-center justify-center border-b px-3"
          data-testid="app-advisor-quick-prompt-header"
        >
          <AppAdvisorIcon className="mr-2 h-4 w-4 fg-primary" />
          <span className="select-none text-s font-semibold fg-primary">
            {ORCHESTRATOR_LABEL}
          </span>
        </div>
        <div className="relative">
          <SlateEditor
            ref={editorRef}
            editor={editor}
            value={value}
            onChange={setValue}
            onKeyDown={handleKeyDown}
            placeholder={`Ask ${ORCHESTRATOR_LABEL}…`}
            containerClassName="min-h-33 max-h-65 cursor-text overflow-y-auto px-4 py-3"
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
        {error && (
          <div
            role="alert"
            className="border-t px-4 py-2 text-xs fg-destructive"
          >
            {error}
          </div>
        )}
      </section>
    </div>
  );
}
