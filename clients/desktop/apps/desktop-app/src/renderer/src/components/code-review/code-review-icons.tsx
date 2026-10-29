import type { JSX, SVGProps } from 'react';
import type { ReviewAnnotationKind } from '@canopy/desktop-shared/types';
import {
  ExplanationIcon as AppCatalogExplanationIcon,
  CautionIcon as AppCatalogCautionIcon,
  CodeBracketsIcon as AppCatalogCodeBracketsIcon,
  ContextIcon as AppCatalogContextIcon,
} from '@canopy/ui-shared/icons/AppIcons';

/**
 * Shared glyphs + color mapping for review annotation kinds, reused by the
 * diff gutter markers (`ReviewDiffContentView`), the annotation popover
 * (`ReviewCommentPopover`), and the annotations strip / file badges
 * (`CodeChangesPanel`, `DiffFileTree`) so the three kinds read consistently
 * everywhere they appear.
 */

export function ExplanationIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogExplanationIcon width="12" height="12" {...props} />;
}

export function CautionIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogCautionIcon width="12" height="12" {...props} />;
}

/** Code brackets glyph for the "search code" toggle in the review modal's
 * cross-panel search bar (mirrors `MapIcon`/`DiagramIcon` in
 * `plan-explore-icons.tsx`). */
export function CodeIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogCodeBracketsIcon width="14" height="14" {...props} />;
}

export function ContextIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogContextIcon width="12" height="12" {...props} />;
}

export function annotationKindIcon(
  kind: ReviewAnnotationKind,
  props?: SVGProps<SVGSVGElement>,
): JSX.Element {
  switch (kind) {
    case 'explanation':
      return <ExplanationIcon {...props} />;
    case 'caution':
      return <CautionIcon {...props} />;
    case 'context':
      return <ContextIcon {...props} />;
  }
}

/** Gutter/badge background tint per annotation kind. */
export const ANNOTATION_KIND_TINT_CLASS: Record<ReviewAnnotationKind, string> =
  {
    explanation: 'bg-info-subtle',
    caution: 'bg-warning-subtle',
    context: 'bg-fg-primary/[0.04]',
  };

/** Icon/text color per annotation kind. */
export const ANNOTATION_KIND_TEXT_CLASS: Record<ReviewAnnotationKind, string> =
  {
    explanation: 'fg-info',
    caution: 'fg-warning',
    context: 'fg-secondary',
  };

/**
 * Persistent gutter-cell tint for a diff line covered by at least one open
 * (non-resolved) comment thread — the "annotation-tint pattern" reused for
 * threads. Deliberately a different, lower-key treatment than the transient
 * GitHub-style selection band (`data-review-selected` in `globals.css`),
 * which only marks the line actively being composed on; this tint persists
 * for as long as the line has an open thread. Lowest priority: an
 * annotation's own kind tint wins when a line has both.
 */
export const THREAD_LINE_TINT_CLASS = 'bg-accent-subtle';
