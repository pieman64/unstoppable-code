import type { JSX, SVGProps } from 'react';
import { QuestionMarkIcon as AppCatalogQuestionMarkIcon } from './AppIcons';

export function QuestionMarkIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return <AppCatalogQuestionMarkIcon width="14" height="14" {...props} />;
}
