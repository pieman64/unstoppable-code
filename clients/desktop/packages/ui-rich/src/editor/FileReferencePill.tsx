import { useFocused, useSelected, type RenderElementProps } from 'slate-react';
import type { JSX } from 'react';
import { INLINE_TOKEN_CHIP_CLASS } from '@canopy/ui-shared/components';

function getFilename(displayPath: string): string {
  const parts = displayPath.split('/');
  return parts[parts.length - 1] || displayPath;
}

// The same chip as a mention in a sent message; the selected token gets an
// accent hairline so it reads as selected inside the editor.
function pillClasses(selected = false, focused = false): string {
  return selected && focused
    ? `${INLINE_TOKEN_CHIP_CLASS} ring-[length:var(--border-hairline)] ring-line-accent`
    : INLINE_TOKEN_CHIP_CLASS;
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
