'use client';

import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

import type { ComponentType, JSX, ReactNode } from 'react';
import {
  DescriptionMarkdown,
  hasMarkdownDescriptionText,
  McpServerLogo,
  type McpServerLogoProps,
} from '@canopy/ui-shared';
import { Heading } from '@canopy/ui-shared/components';

export interface MarketplaceEntityHeaderProps {
  privateName?: boolean;
  name: string;
  description?: string;
  logo?: { logoUrl?: string; bundledLogo?: string; brandMark?: boolean };
  McpServerLogoComponent?: ComponentType<McpServerLogoProps>;
  meta?: ReactNode;
  titleId?: string;
  children?: ReactNode;
}

/** Shared identity and description with host-owned attribution and actions. */
export function MarketplaceEntityHeader({
  name,
  privateName = false,
  description,
  logo,
  McpServerLogoComponent = McpServerLogo,
  meta,
  titleId = 'plugin-detail-title',
  children,
}: MarketplaceEntityHeaderProps): JSX.Element {
  return (
    <header
      data-testid="marketplace-entity-header"
      className="flex items-start gap-4"
    >
      <McpServerLogoComponent
        {...logo}
        name={name}
        size={40}
        fallback="monogram"
        shape="circle"
        fit="contain"
      />
      <div className="min-w-0 flex-1">
        <Heading level={1} variant="page" id={titleId}>
          {privateName ? (
            <span className={REPLAY_MASK_CLASS}>{name}</span>
          ) : (
            name
          )}
        </Heading>
        {hasMarkdownDescriptionText(description) && (
          <DescriptionMarkdown className="mt-2" dataTestId="share-description">
            {description}
          </DescriptionMarkdown>
        )}
        {meta && <p className="mt-2 text-xs fg-tertiary">{meta}</p>}
        {children}
      </div>
    </header>
  );
}
