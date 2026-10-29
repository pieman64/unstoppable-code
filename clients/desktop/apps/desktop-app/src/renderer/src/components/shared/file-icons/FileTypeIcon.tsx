import { memo, useId, type JSX } from 'react';
import { getFileIconDef } from './resolve';
import { FileIcon } from '@canopy/ui-shared/icons/AppIcons';

interface FileTypeIconProps {
  filename: string;
  // Language id (eg. "typescript") used as a fallback when filename has no
  // recognizable extension — useful for chat artifacts.
  language?: string;
  size?: number;
  // Layout footprint — the icon renders at `size` but only consumes `boxSize`
  // worth of vertical/horizontal flex space (negative margins absorb the
  // overflow). Use when the icon needs to look bigger than the line-height of
  // its container without growing the row, eg. file-type icons inside a
  // text-xs chat tab.
  boxSize?: number;
  className?: string;
  title?: string;
}

// Renders a Seti file-type icon for the given filename. The wrapper SVG fixes
// the box size; per-icon `viewBox` and inline `fill` colors come from
// `icon-registry.ts` (sourced from jesseweed/seti-ui).
//
// When the filename has no Seti mapping, we fall back to the project's
// generic outline FileIcon — Seti's own `default` glyph uses a wide viewBox
// that renders poorly at small sizes.
//
// We render the icon's path data via dangerouslySetInnerHTML rather than
// JSX. This trades type-checked JSX for a single small <svg> per icon and
// avoids hand-authoring 130+ React components — the source content is
// trusted (vendored from a pinned upstream).
export const FileTypeIcon = memo(function FileTypeIcon({
  filename,
  language,
  size = 24,
  boxSize,
  className,
  title,
}: FileTypeIconProps): JSX.Element {
  const titleId = useId();
  const def = getFileIconDef(filename, { language });
  if (!def) {
    // Fall back to the project's outline FileIcon at its original 14px box,
    // independent of the per-call `size` (the outline glyph is built for that
    // size and looks gangly when scaled up).
    return (
      <FileIcon
        className={className}
        size={14}
        ariaHidden={!title}
        title={title}
      />
    );
  }
  const overflow = boxSize !== undefined ? (size - boxSize) / 2 : 0;
  const style = overflow > 0 ? { margin: `-${overflow}px` } : undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox={def.viewBox}
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role={title ? 'img' : 'presentation'}
      aria-labelledby={title ? titleId : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title id={titleId}>{title}</title> : null}
      <g dangerouslySetInnerHTML={{ __html: def.paths }} />
    </svg>
  );
});
