import type { JSX } from 'react';
import {
  CodeBracketsIcon as AppCatalogCodeBracketsIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Code brackets (`<>`) glyph. Reused by the chat tool-display registry to
 * give the shared plan/review comment tools (`RespondToComment`,
 * `GetReviewComments`) a code-flavored icon in Code Review chats.
 * Plan Explore chats keep `PlanModeIcon` for the same tools.
 */
export function CodeBracketsIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogCodeBracketsIcon size="sm" {...props} />;
}
