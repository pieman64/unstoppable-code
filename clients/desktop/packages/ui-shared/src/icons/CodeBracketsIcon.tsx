import type { JSX, SVGProps } from 'react';
import { CodeBracketsIcon as AppCatalogCodeBracketsIcon } from './AppIcons';

/**
 * Code brackets (`<>`) glyph. Reused by the chat tool-display registry to
 * give the shared plan/review comment tools (`RespondToComment`,
 * `GetReviewComments`) a code-flavored icon in Code Review chats, mirroring
 * the desktop Code Review modal's own anchor-header glyph
 * (`apps/desktop-app/.../code-review/code-review-icons.tsx`'s `CodeIcon`,
 * which stays desktop-local since it is also used outside the chat tool
 * registry). Plan Explore chats keep `PlanModeIcon` for the same tools.
 */
export function CodeBracketsIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogCodeBracketsIcon width="14" height="14" {...props} />;
}
