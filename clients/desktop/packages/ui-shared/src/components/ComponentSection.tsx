import type { JSX, ReactNode } from 'react';
import { PluginDetailSectionHeading } from './PluginDetailSectionHeading';
import { ChevronDownIcon } from '../icons/AppIcons';

/**
 * Titled bordered section wrapping a plugin component list (skills, agents,
 * commands, …) in the plugin detail view. The outline groups the heading
 * with its content without adding another border around the inner table.
 */
export function ComponentSection({
  title,
  children,
  collapsible = false,
}: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
}): JSX.Element {
  if (collapsible) {
    return (
      <details className="group/component min-w-0 rounded-lg ring-[length:var(--border-hairline)] ring-line-base bg-secondary/30">
        <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 [&::-webkit-details-marker]:hidden">
          <PluginDetailSectionHeading as="span">
            {title}
          </PluginDetailSectionHeading>
          <ChevronDownIcon
            size={14}
            className="shrink-0 fg-secondary group-open/component:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="overflow-x-auto rounded-b-lg border-t">{children}</div>
      </details>
    );
  }
  return (
    <section className="min-w-0 rounded-lg ring-[length:var(--border-hairline)] ring-line-base bg-secondary/30">
      <div className="px-4 py-3">
        <PluginDetailSectionHeading>{title}</PluginDetailSectionHeading>
      </div>
      <div className="overflow-x-auto rounded-b-lg border-t">{children}</div>
    </section>
  );
}
