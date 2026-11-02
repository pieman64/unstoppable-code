import type { JSX, SVGProps } from 'react';

/* eslint-disable shadcn/no-raw-colors -- OpenCode's official tile colors. DESIGN.md keeps provider-owned brand colors literal. */

/** OpenCode's app icon, from https://opencode.ai/favicon.svg. */
export function OpenCodeLogo(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 512 512"
      fill="none"
      {...props}
    >
      <rect width="512" height="512" fill="#131010" />
      <path d="M320 224V352H192V224H320Z" fill="#5A5858" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="#fff"
      />
    </svg>
  );
}
