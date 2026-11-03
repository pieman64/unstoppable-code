import { useEffect, useRef } from 'react';
import type { DetailMoreMenuItem } from '@canopy/ui-shared/components/DetailMoreMenu';
import { CopyIcon } from '@canopy/ui-shared/icons/AppIcons';
import { SHARED_BY_YOU_COPY_LINK_LABEL } from '@canopy/ui-shared/lib/shared-by-you';
import {
  copySharedByYouScopedLink,
  sharedByYouScopedLinkNotice,
  type SharedByYouCopyLinkPort,
  type SharedByYouScopedLink,
} from '../sharing/sharedByYouScopedLink';

/**
 * The owner's Copy link in a skill page's ⋯ menu (CAN-5452): the same member
 * link and notice as the Shared by you row. `null` when the loaded facts do
 * not form a link, so the host adds nothing. A write that settles after the
 * page moved to another item, or unmounted, posts no notice.
 */
export function useSharedByYouCopyLinkMenuItem(
  link: SharedByYouScopedLink | null,
  port: SharedByYouCopyLinkPort,
): DetailMoreMenuItem | null {
  const identity = link
    ? `${link.url}:${sharedByYouScopedLinkNotice(link)}`
    : null;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
    };
  }, []);
  if (link === null) return null;
  return {
    id: 'copy-scoped-link',
    label: SHARED_BY_YOU_COPY_LINK_LABEL,
    icon: <CopyIcon size="sm" aria-hidden />,
    testId: 'shared-by-you-copy-link-menu',
    onSelect: (): void => {
      void copySharedByYouScopedLink(
        link,
        port,
        () => mounted.current && currentIdentity.current === identity,
      );
    },
  };
}
