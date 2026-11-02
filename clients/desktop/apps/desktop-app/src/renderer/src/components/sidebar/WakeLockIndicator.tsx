import { type JSX, useCallback, useEffect, useState } from 'react';
import { SECONDARY_SURFACE_CLASS, Tooltip } from '@canopy/ui-shared';
import { isWakeLockSupportedPlatform } from '@canopy/desktop-shared/platform-capabilities';
import type { WakeLockState } from '@canopy/desktop-shared/types';
import { pt } from '@/lib/platform-text';
import { useLabsExperimentEnabled } from '@/stores/labsExperimentsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { SnoozeIcon } from '../icons/SnoozeIcon';
import {
  APP_STATUS_ICON_CLASSNAME,
  APP_STATUS_LABEL_CLASSNAME,
  SIDEBAR_LIST_ICON_CLASSNAME,
  SIDEBAR_LIST_ITEM_CLASSNAME,
} from './sidebar-styles';

/**
 * Status-bar variant: a compact labeled chip on the house secondary control
 * surface (`SECONDARY_SURFACE_CLASS`: the quaternary shell, elevation, and
 * hairline shared with the header `Open in` pill, secondary buttons, and the
 * chat bubble badges). It floats in the bottom-right corner of the main
 * shell over arbitrary panel content, so it needs its own surface and a
 * written label to read as deliberate chrome — a bare glyph there looked
 * like a stray icon under the composer. Quiet ink that brightens on hover.
 */
const APP_STATUS_PILL_CLASSNAME = `focus-ring group inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full pl-2 pr-2.5 text-2xs font-medium fg-secondary transition-colors hover:fg-primary ${SECONDARY_SURFACE_CLASS}`;

/**
 * The glyph follows the label on hover so the whole chip lights up, not just
 * the text: `group-hover` from the pill, same as the app-status label class.
 */
const APP_STATUS_PILL_ICON_CLASSNAME = `${APP_STATUS_ICON_CLASSNAME} transition-colors duration-150 group-hover:fg-primary`;

interface WakeLockIndicatorProps {
  /**
   * Sidebar-row mode only: hides the label and moves the wording into the
   * tooltip. Ignored in `statusBar` mode, where the pill always keeps its
   * label.
   */
  collapsed: boolean;
  statusBar?: boolean;
}

interface WakeLockIndicatorViewProps extends WakeLockIndicatorProps {
  /** The wake-lock state to present; `null` renders nothing. */
  state: WakeLockState | null;
  onClick: () => void;
}

/**
 * Presentational half of {@link WakeLockIndicator}: the pill (or sidebar
 * row) for a given wake-lock state. Split out so the dev-only Change review
 * page can show the shipping markup with a seeded state instead of waiting
 * on a live agent to hold the lock.
 */
export function WakeLockIndicatorView({
  state,
  collapsed,
  statusBar = false,
  onClick,
}: WakeLockIndicatorViewProps): JSX.Element | null {
  if (
    !isWakeLockSupportedPlatform(window.platform) ||
    !state?.active ||
    !state.enabled ||
    state.holderCount <= 0
  ) {
    return null;
  }

  const ariaLabel =
    state.holderCount === 1
      ? pt({
          default:
            'Sleep paused: 1 active agent or workflow. Your device can lock and turn off the display.',
          darwin:
            'Sleep paused: 1 active agent or workflow. Your Mac can lock and turn off the display.',
          win32:
            'Sleep paused: 1 active agent or workflow. Your PC can lock and turn off the display.',
        })
      : pt({
          default: `Sleep paused: ${state.holderCount} active agents or workflows. Your device can lock and turn off the display.`,
          darwin: `Sleep paused: ${state.holderCount} active agents or workflows. Your Mac can lock and turn off the display.`,
          win32: `Sleep paused: ${state.holderCount} active agents or workflows. Your PC can lock and turn off the display.`,
        });

  // The pill's short label ("Sleep paused") is always visible, so the tooltip
  // carries the full explanation. The sidebar row only needs the tooltip while
  // the written label is hidden.
  const labelHidden = !statusBar && collapsed;

  return (
    <Tooltip
      label={ariaLabel}
      className={statusBar ? undefined : 'w-full'}
      disabled={!statusBar && !collapsed}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        data-testid="sidebar-wake-lock-indicator"
        className={
          statusBar
            ? APP_STATUS_PILL_CLASSNAME
            : `${SIDEBAR_LIST_ITEM_CLASSNAME} fg-primary hover:bg-subtle`
        }
      >
        <span
          className={
            statusBar
              ? APP_STATUS_PILL_ICON_CLASSNAME
              : `${SIDEBAR_LIST_ICON_CLASSNAME} fg-secondary`
          }
        >
          <SnoozeIcon size={statusBar ? 14 : 16} />
        </span>
        <span
          className={`truncate ${
            statusBar ? APP_STATUS_LABEL_CLASSNAME : 'fg-primary'
          } ${labelHidden ? 'w-0 opacity-0' : 'opacity-100'}`}
        >
          Sleep paused
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * The live "Sleep paused" pill. It renders (and subscribes to wake-lock
 * state) only while Settings → Labs → Early access is off; early
 * access hides it. The wake lock itself is unaffected by the switch.
 */
export function WakeLockIndicator(
  props: WakeLockIndicatorProps,
): JSX.Element | null {
  const experimentalFeaturesEnabled = useLabsExperimentEnabled('sidebar');
  if (experimentalFeaturesEnabled) {
    return null;
  }
  return <LiveWakeLockIndicator {...props} />;
}

function LiveWakeLockIndicator({
  collapsed,
  statusBar = false,
}: WakeLockIndicatorProps): JSX.Element | null {
  const [state, setState] = useState<WakeLockState | null>(null);
  const openSettings = useNavigationStore((s) => s.openSettings);

  const handleClick = useCallback((): void => {
    openSettings('performance');
  }, [openSettings]);

  useEffect(() => {
    if (!isWakeLockSupportedPlatform(window.platform)) {
      return;
    }

    let mounted = true;
    let subscriptionEventCount = 0;
    const initialStatePromise = window.api.getWakeLockState();
    const unsubscribe = window.api.onWakeLockStateChanged((nextState) => {
      subscriptionEventCount += 1;
      if (mounted) {
        setState(nextState);
      }
    });

    void initialStatePromise
      .then((initialState) => {
        if (mounted && subscriptionEventCount === 0) {
          setState(initialState);
        }
      })
      .catch(() => {
        // Wake-lock status is advisory UI; failure should not disturb sidebar.
      });

    return (): void => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  return (
    <WakeLockIndicatorView
      state={state}
      collapsed={collapsed}
      statusBar={statusBar}
      onClick={handleClick}
    />
  );
}
