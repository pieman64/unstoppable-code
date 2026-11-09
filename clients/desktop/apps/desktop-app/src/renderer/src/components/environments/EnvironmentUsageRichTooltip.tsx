import { Stack } from '@canopy/ui-shared/components';
import type { JSX, ReactElement } from 'react';
import {
  RichHoverTooltip,
  type TooltipTriggerProps,
} from '@/components/shared/RichHoverTooltip';

interface EnvironmentUsageRichTooltipProps {
  title: string;
  items: ReadonlyArray<string>;
  children: ReactElement<TooltipTriggerProps>;
  dataTestId?: string;
}

/**
 * Portaled rich tooltip used by the per-kind usage indicators on the
 * Settings → Environments list rows. Renders a heading and a bullet list of matching
 * usages. Thin wrapper over {@link RichHoverTooltip}.
 */
export function EnvironmentUsageRichTooltip({
  title,
  items,
  children,
  dataTestId,
}: EnvironmentUsageRichTooltipProps): JSX.Element {
  return (
    <RichHoverTooltip
      dataTestId={dataTestId}
      surfaceClassName="min-w-40 max-w-70"
      surfacePadding="card"
      content={
        <Stack gap="tight">
          <span className="block text-3xs font-semibold fg-secondary">
            {title}
          </span>
          <ul className="flex flex-col gap-0.5">
            {items.map((item, index) => (
              <li key={`${item}-${index}`} className="truncate">
                {item}
              </li>
            ))}
          </ul>
        </Stack>
      }
    >
      {children}
    </RichHoverTooltip>
  );
}
