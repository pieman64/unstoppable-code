import type { JSX, SVGProps } from 'react';
import { CognitionIcon as AppCatalogCognitionIcon } from './AppIcons';

export function CognitionIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogCognitionIcon
      width="16"
      height="16"
      aria-hidden="true"
      {...props}
    />
  );
}
