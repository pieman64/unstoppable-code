import type { JSX, ReactNode } from 'react';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  Button,
  DetailActionBar,
  DetailActionSlotsProvider,
  DetailHeader,
  DetailMoreMenu,
  useDetailActionSlots,
  type DetailMoreMenuItem,
  Heading,
} from '@canopy/ui-shared/components';
import { ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

/** The item header the shell renders in place of its Back row (CAN-4266). */
export interface MarketplaceDetailPageHeader {
  /** One line under the title saying what the item is. */
  description?: ReactNode;
  /** Quiet facts under the description: author, audience. */
  meta?: readonly ReactNode[];
}

export interface MarketplaceDetailPageShellProps {
  title: string;
  privateTitle?: boolean;
  onNavigateBack?: () => void;
  /**
   * Secondary page actions for the standard action bar at the top right of
   * the Back row: `[secondary…] [Share] [Primary]`. Bodies declare their own
   * through `DetailPageActions`, which join the same bar.
   */
  headerActions?: ReactNode;
  /** The Marketplace Share, placed immediately before the primary action. */
  share?: ReactNode;
  breadcrumbs?: ReactNode;
  contentOwnsTitle?: boolean;
  /**
   * `constrained` (default) centers the page in the reading column every
   * existing desktop and portal detail host relies on; `fluid` fills the
   * host's container so a host that owns its own width — the public
   * Marketplace landers (CAN-2989) — can lay out beside an aside.
   */
  width?: 'constrained' | 'fluid';
  /**
   * Renders the item's `DetailHeader` (title, description, meta) with the
   * actions beside the title, `[⋯ More] [secondary…] [Share] [Primary]`,
   * instead of the Back row: the breadcrumb is the way back. Bodies then
   * leave the title to the shell and declare their actions as before.
   */
  header?: MarketplaceDetailPageHeader;
  /** Rarer actions for the header's ⋯ More menu; a destructive one last. */
  moreItems?: readonly DetailMoreMenuItem[];
  children: ReactNode;
}

/** Browser-safe page chrome shared by marketplace detail surfaces. */
export function MarketplaceDetailPageShell({
  title,
  privateTitle = false,
  onNavigateBack,
  headerActions,
  share,
  breadcrumbs,
  contentOwnsTitle = false,
  width = 'constrained',
  header,
  moreItems = [],
  children,
}: MarketplaceDetailPageShellProps): JSX.Element {
  const slots = useDetailActionSlots();
  const hasActions = Boolean(headerActions || share || slots.declared > 0);
  const sectionClassName =
    width === 'fluid'
      ? 'flex min-h-0 w-full flex-col pt-8'
      : 'mx-auto flex min-h-0 w-full max-w-3xl flex-col pt-8';
  const titleText = privateTitle ? (
    <span className={REPLAY_MASK_CLASS}>{title}</span>
  ) : (
    title
  );
  if (header) {
    return (
      <section
        className={sectionClassName}
        data-testid="plugins-entry-detail"
        aria-labelledby="plugins-entry-detail-title"
      >
        {breadcrumbs !== undefined && (
          <div className="mb-4 flex shrink-0 items-center">{breadcrumbs}</div>
        )}
        <div className="mb-6">
          <DetailHeader
            dataTestId="plugins-entry-detail-header"
            title={titleText}
            titleId="plugins-entry-detail-title"
            description={header.description}
            meta={header.meta}
            actions={
              <>
                <DetailMoreMenu
                  name={title}
                  items={moreItems}
                  triggerTestId="plugins-entry-detail-more"
                  menuTestId="plugins-entry-detail-menu"
                />
                {/* Always mounted: body-declared actions portal into its
                    slots, so the bar must exist before they register. */}
                <DetailActionBar
                  secondary={headerActions}
                  share={share}
                  slots={slots}
                />
              </>
            }
          />
        </div>
        <DetailActionSlotsProvider slots={slots}>
          {children}
        </DetailActionSlotsProvider>
      </section>
    );
  }
  return (
    <section
      className={
        width === 'fluid'
          ? 'flex min-h-0 w-full flex-col pt-8'
          : 'mx-auto flex min-h-0 w-full max-w-3xl flex-col pt-8'
      }
      data-testid="plugins-entry-detail"
      aria-labelledby={
        contentOwnsTitle ? 'plugin-detail-title' : 'plugins-entry-detail-title'
      }
    >
      {contentOwnsTitle ? (
        <span id="plugins-entry-detail-title" className="sr-only">
          {privateTitle ? (
            <span className={REPLAY_MASK_CLASS}>{title}</span>
          ) : (
            title
          )}
        </span>
      ) : (
        <Heading
          level={1}
          variant="page"
          id="plugins-entry-detail-title"
          className="sr-only"
        >
          {privateTitle ? (
            <span className={REPLAY_MASK_CLASS}>{title}</span>
          ) : (
            title
          )}
        </Heading>
      )}
      {/*
        `mb-6` matches the 24px `PluginDetailContent` puts under its own Back
        chrome (`gap-6`), which is the spacing users read as normal on a detail
        page. It was 8px, which only looked right on the one child that
        happened to add its own top padding. Children are expected not to add
        any: the row owns the gap.
      */}
      {(breadcrumbs !== undefined || onNavigateBack || hasActions) && (
        <div className="mb-6 flex shrink-0 items-center justify-between gap-2">
          {breadcrumbs !== undefined ? (
            breadcrumbs
          ) : onNavigateBack ? (
            <Button
              type="button"
              variant="ghost"
              size="compact"
              onClick={onNavigateBack}
              data-testid="plugins-entry-detail-back"
            >
              <AppCatalogChevronLeftMediumIcon
                width="12"
                height="12"
                aria-hidden
              />
              Back
            </Button>
          ) : (
            <span />
          )}
          {hasActions && (
            <DetailActionBar
              secondary={headerActions}
              share={share}
              slots={slots}
            />
          )}
        </div>
      )}
      <DetailActionSlotsProvider slots={slots}>
        {children}
      </DetailActionSlotsProvider>
    </section>
  );
}
