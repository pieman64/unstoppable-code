import { useFocused, useSelected, type RenderElementProps } from 'slate-react';
import type { JSX } from 'react';

function getFilename(displayPath: string): string {
  const parts = displayPath.split('/');
  return parts[parts.length - 1] || displayPath;
}

function pillClasses(selected = false, focused = false): string {
  return `inline-flex max-w-full items-center rounded-md border px-1.5 py-0.5 font-mono text-xs ${
    selected && focused
      ? 'border-line-accent/60 bg-accent-subtle fg-accent'
      : 'border-line-accent/30 bg-accent-subtle fg-accent'
  }`;
}

export function FileReferencePillElement({
  attributes,
  children,
  element,
}: RenderElementProps): JSX.Element {
  const selected = useSelected();
  const focused = useFocused();
  if (element.type !== 'file-reference') {
    return <span {...attributes}>{children}</span>;
  }
  const label = getFilename(element.displayPath);

  return (
    <span {...attributes} contentEditable={false}>
      <span
        className={pillClasses(selected, focused)}
        title={element.displayPath}
        data-testid="file-reference-pill"
        data-mention-kind={element.kind}
      >
        @{label}
      </span>
      {children}
    </span>
  );
}
