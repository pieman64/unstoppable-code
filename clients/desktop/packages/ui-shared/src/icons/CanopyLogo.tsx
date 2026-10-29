import type { JSX, SVGProps } from 'react';

export function CanopyLogo(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path
        d="
          M 11.5 21.5
          C 11.45 20, 11.3 17.5, 11.0 15.0
          C 10.4 12.5, 9.5 11.5, 8.5 11.0
          C 5.5 9.5, 2.0 8.8, 1.3 10.3
          C 1.15 9.4, 1.55 8.5, 2.3 7.6
          C 3.5 6.3, 5.6 5.5, 8 5
          C 9.1 4.8, 10.7 4.7, 12 4.7
          C 12.9 4.7, 14.5 4.7, 16.4 5.1
          C 18.8 5.6, 20.7 6.4, 21.8 7.6
          C 22.5 8.4, 22.85 9.4, 22.7 10.3
          C 22.0 8.8, 18.5 9.5, 15.5 11.0
          C 14.5 11.5, 13.6 12.5, 13.0 15.0
          C 12.7 17.5, 12.55 20, 12.5 21.5
          Z"
      />
    </svg>
  );
}
