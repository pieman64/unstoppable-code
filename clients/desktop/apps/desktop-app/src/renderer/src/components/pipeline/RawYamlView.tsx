import { type JSX, useCallback } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

interface RawYamlViewProps {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  readonly: boolean;
}

export function RawYamlView({
  value,
  onChange,
  error,
  readonly,
}: RawYamlViewProps): JSX.Element {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      onChange(e.target.value);
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      // Insert two spaces on Tab instead of moving focus (skip in readonly mode)
      if (e.key === 'Tab' && !readonly) {
        e.preventDefault();
        const target = e.currentTarget;
        const start = target.selectionStart;
        const end = target.selectionEnd;
        const newValue =
          value.substring(0, start) + '  ' + value.substring(end);
        onChange(newValue);
        // Restore cursor position after React re-render
        requestAnimationFrame((): void => {
          target.selectionStart = start + 2;
          target.selectionEnd = start + 2;
        });
      }
    },
    [value, onChange, readonly],
  );

  return (
    // Blocked from session replay: the YAML and its parse error. The block
    // class carries no style, so the sizing note above still holds.
    <div
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex-1 flex flex-col overflow-hidden`}
    >
      {error && (
        <div
          data-testid="pipeline-raw-yaml-error"
          className="px-4 py-2 bg-destructive-subtle border-b border-line-destructive/30 fg-destructive text-xs shrink-0"
        >
          {error}
        </div>
      )}
      <textarea
        data-testid="pipeline-raw-yaml-textarea"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        readOnly={readonly}
        spellCheck={false}
        className="flex-1 w-full resize-none bg-base p-4 font-mono text-xs leading-5 fg-primary
          outline-none border-none focus:ring-0 placeholder:fg-secondary
          disabled:opacity-50 disabled:cursor-not-allowed"
        placeholder="# Pipeline YAML"
      />
    </div>
  );
}
