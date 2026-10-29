import type { JSX } from 'react';

/**
 * Name + optional one-line description rendered as a click target, used by the
 * plugin detail component lists. Ported from the desktop `PluginDetailView`
 * internal — class names match it exactly so tests/selectors and visual diffs
 * are unchanged.
 */
export function ClickableName({
  name,
  description,
  onClick,
}: {
  name: string;
  description?: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" onClick={onClick} className="text-left group">
      <span className="fg-primary font-medium group-hover:fg-accent transition-colors">
        {name}
      </span>
      {description && (
        <p className="text-xs fg-secondary mt-0.5 line-clamp-1">
          {description}
        </p>
      )}
    </button>
  );
}
