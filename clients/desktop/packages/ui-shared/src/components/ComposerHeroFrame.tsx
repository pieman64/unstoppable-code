import type { JSX, ReactNode } from 'react';

export type ComposerHeroFrameRhythm = 'spacious' | 'compact';

/**
 * `centred`: the composer's midpoint sits on the frame's centre and everything
 * else hangs off it. `column`: a plain top-to-bottom column (the web phone
 * hero). Both render the same element tree, so a host can switch between them
 * without remounting the composer.
 */
export type ComposerHeroFrameLayout = 'centred' | 'column';

const COLUMN_CLASSNAME =
  'relative flex w-full max-w-3xl flex-col items-center gap-5 sm:gap-6';

const GROUP_CLASSNAME: Record<ComposerHeroFrameRhythm, string> = {
  spacious: 'absolute inset-x-0 top-1/2 w-full px-6',
  compact: 'absolute inset-x-0 top-1/2 w-full',
};

const ROWS_CLASSNAME: Record<ComposerHeroFrameRhythm, string> = {
  spacious: 'absolute inset-x-0 top-full flex flex-col pb-6',
  compact: 'absolute inset-x-0 top-full flex flex-col',
};

const BELOW_CLASSNAME: Record<ComposerHeroFrameRhythm, string> = {
  spacious: 'mt-16 flex w-full flex-col gap-16',
  compact: 'mt-5 flex w-full flex-col gap-5 sm:mt-6 sm:gap-6',
};

export interface ComposerHeroFrameProps {
  /** Hangs above the composer, out of flow: the heading and its notices. */
  readonly above?: ReactNode;
  /** The composer box. Its vertical midpoint sits on the frame's centre. */
  readonly composer: ReactNode;
  /**
   * Hangs under the composer, out of flow. It never moves the composer; the
   * `below` rows move down by its height instead.
   */
  readonly hanging?: ReactNode;
  /** Rows under the composer and `hanging`: suggestions, setup steps, recents. */
  readonly below?: ReactNode;
  /**
   * `spacious`: the desktop Home rhythm, 64px from the composer to the rows
   * and between them, with the rows padded so overflowing rows clear the
   * scroll limit. `compact`: the web hero rhythm, 20px (24px from `sm`), with
   * the host's own section supplying the padding.
   */
  readonly rhythm: ComposerHeroFrameRhythm;
  /** Defaults to `centred`. */
  readonly layout?: ComposerHeroFrameLayout;
  readonly anchorTestId?: string;
  readonly groupTestId?: string;
  readonly shellTestId?: string;
  readonly hangingTestId?: string;
}

/**
 * The composer hero's positioning frame, shared by the desktop Home surface and
 * the web New Task and guest heroes.
 *
 * The composer is the control the visitor is aiming at, so nothing that
 * arrives around it may move it. Its midpoint sits on the frame's centre (the
 * group's top, with the shell translated up by half its height); the heading
 * hangs above it, and everything under it (`hanging`, then the `below` rows)
 * hangs from its bottom edge in one column. Rows that load, grow or disappear
 * change nothing above them, and rows that outgrow the frame extend the host's
 * scroll area below the composer.
 *
 * Pure CSS on purpose: no measurement, so the server HTML already has the
 * final geometry and hydrating moves nothing.
 */
export function ComposerHeroFrame({
  above,
  composer,
  hanging,
  below,
  rhythm,
  layout = 'centred',
  anchorTestId,
  groupTestId,
  shellTestId,
  hangingTestId,
}: ComposerHeroFrameProps): JSX.Element {
  // The column keeps every wrapper and lets the ones that only position the
  // centred frame drop out of layout with `contents`.
  const column = layout === 'column';
  return (
    <div
      data-testid={anchorTestId}
      data-layout={layout}
      className={
        column ? COLUMN_CLASSNAME : 'relative h-48 w-full max-w-3xl shrink-0'
      }
    >
      <div
        data-testid={groupTestId}
        className={column ? 'contents' : GROUP_CLASSNAME[rhythm]}
      >
        <div
          data-testid={shellTestId}
          className={column ? 'contents' : 'relative w-full -translate-y-1/2'}
        >
          <div
            className={
              column
                ? 'contents'
                : 'pointer-events-none absolute inset-x-0 bottom-full flex flex-col items-stretch'
            }
          >
            {above}
          </div>
          {/* Above the rows that hang after it, so the composer's own menus
              open over them. */}
          <div className={column ? 'relative z-10 w-full' : 'relative z-10'}>
            {composer}
          </div>
          <div className={column ? 'contents' : ROWS_CLASSNAME[rhythm]}>
            <div
              data-testid={hangingTestId}
              className={column ? 'contents' : undefined}
            >
              {hanging}
            </div>
            <div className={column ? 'contents' : BELOW_CLASSNAME[rhythm]}>
              {below}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
