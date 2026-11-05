'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { DetailMoreMenuItem } from '@canopy/ui-shared/components/DetailMoreMenu';
import { CopyIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  copyMarketplaceLink,
  marketplaceLinkCopiedNotice,
  type MarketplaceLinkAccess,
} from '../sharing/marketplaceShareLink';
import type { SharedByYouCopyLinkPort } from '../sharing/sharedByYouScopedLink';

export function useMarketplaceCopyLinkMenuItem(
  value: {
    readonly link: string;
    readonly access: MarketplaceLinkAccess;
  } | null,
  port: SharedByYouCopyLinkPort,
): DetailMoreMenuItem | null {
  const identity = value
    ? `${value.link}:${marketplaceLinkCopiedNotice(value.access)}`
    : null;
  const current = useRef(identity);
  useLayoutEffect(() => {
    current.current = identity;
  }, [identity]);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return (): void => {
      active.current = false;
    };
  }, []);
  if (!value) return null;
  return {
    id: 'copy-link',
    label: 'Copy link',
    icon: <CopyIcon size="sm" aria-hidden />,
    testId: 'marketplace-copy-link-menu',
    onSelect: () => {
      void copyMarketplaceLink(
        value.link,
        value.access,
        port,
        () => active.current && current.current === identity,
      );
    },
  };
}
