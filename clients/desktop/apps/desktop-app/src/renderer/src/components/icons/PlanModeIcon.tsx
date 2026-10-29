import type { JSX, SVGProps } from 'react';

export function PlanModeIcon(
  props: SVGProps<SVGSVGElement> & { active?: boolean },
): JSX.Element {
  const { active = false, ...svgProps } = props;

  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...svgProps}
    >
      {active ? (
        <>
          <path d="M9,4V18L3,20V6Z" fill="currentColor" opacity="0.3" />
          <path d="M15,6V20L21,18V4Z" fill="currentColor" opacity="0.3" />
        </>
      ) : null}
      <path d="M21,4V18l-6,2L9,18,3,20V6L9,4l6,2Z" />
      <path d="M15,6,9,4V18l6,2Z" />
    </svg>
  );
}
