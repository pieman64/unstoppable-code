import { useRef, type JSX } from 'react';
import { SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS } from '@canopy/desktop-shared/scripts';
import {
  createScriptEnvVarInsertion,
  insertTextAtSelection,
} from '@/lib/scriptEditor';
import { VariableInsertDropdown } from './VariableInsertDropdown';

export interface ScriptCommandEditorProps {
  label: string;
  value: string;
  onChange: (nextValue: string) => void;
  placeholder?: string;
  rows?: number;
}

export function ScriptCommandEditor({
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: ScriptCommandEditorProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef({
    start: 0,
    end: 0,
  });

  const rememberSelection = (): void => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    selectionRef.current = {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
    };
  };

  const insertVariable = (variableName: string): void => {
    const insertedText = createScriptEnvVarInsertion(variableName);
    const nextSelection =
      textareaRef.current && document.activeElement === textareaRef.current
        ? {
            start: textareaRef.current.selectionStart,
            end: textareaRef.current.selectionEnd,
          }
        : selectionRef.current;
    const insertion = insertTextAtSelection({
      value,
      insertedText,
      selectionStart: nextSelection.start,
      selectionEnd: nextSelection.end,
    });

    onChange(insertion.value);

    requestAnimationFrame((): void => {
      const textarea = textareaRef.current;
      if (!textarea) {
        return;
      }

      textarea.focus();
      textarea.selectionStart = insertion.cursorPosition;
      textarea.selectionEnd = insertion.cursorPosition;
      selectionRef.current = {
        start: insertion.cursorPosition,
        end: insertion.cursorPosition,
      };
    });
  };

  return (
    <div className="space-y-2">
      <label className="block text-s">
        <span className="mb-1.5 block text-xs fg-secondary">{label}</span>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onSelect={rememberSelection}
          onClick={rememberSelection}
          onKeyUp={rememberSelection}
          placeholder={placeholder}
          rows={rows}
          className="focus-ring w-full resize-y rounded-lg border bg-base px-3 py-2 font-mono text-xs"
        />
      </label>

      <VariableInsertDropdown
        variables={SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS}
        onInsert={insertVariable}
      />
    </div>
  );
}
