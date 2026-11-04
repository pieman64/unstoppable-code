import type { JSX, ReactNode } from 'react';
import { Heading } from './Heading';

export interface CustomizeSectionProps {
  /** Stable DOM id; also the target of `#customize-section-<id>` anchors. */
  readonly domId: string;
  readonly title: string;
  /** Matching entries before any preview, shown beside the title. */
  readonly count?: number;
  /** Trailing heading controls (Update all, pipeline filters). */
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly footnote?: ReactNode;
}

/** One headed band of the Customize page: heading, hairline, then content. */
export function CustomizeSection({
  domId,
  title,
  count,
  actions,
  children,
  footnote,
}: CustomizeSectionProps): JSX.Element {
  const headingId = `${domId}-heading`;
  return (
    <section
      id={domId}
      data-testid={domId}
      aria-labelledby={headingId}
      className="scroll-mt-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b pb-2">
        <div className="flex h-7 min-w-0 items-center">
          <Heading
            level={2}
            variant="section"
            id={headingId}
            className="min-w-0"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{title}</span>
              {count !== undefined && (
                <span
                  data-testid={`${domId}-count`}
                  className="shrink-0 text-s font-normal fg-tertiary"
                >
                  {count}
                </span>
              )}
            </span>
          </Heading>
        </div>
        {actions}
      </div>
      {children}
      {footnote && (
        <div className="pt-3">
          <p data-testid={`${domId}-footnote`} className="text-xs fg-tertiary">
            {footnote}
          </p>
        </div>
      )}
    </section>
  );
}
