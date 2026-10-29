import type { JSX, SVGProps } from 'react';

export function DotIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}
