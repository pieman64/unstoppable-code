import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { Popover, Tooltip } from '@canopy/ui-shared';
import {
  ChipSimpleIcon,
  ResourceMonitorIcon,
  type IconSize,
} from '@canopy/ui-shared/icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib';
import { useResourceMonitorStore } from '@/stores/resourceMonitorStore';
import { ResourceDiagnosticsPopover } from './ResourceDiagnosticsPopover';
import {
  selectCompactResourceLayout,
  type CompactResourceLayout,
} from './compact-resource-layout';
import { formatCpuPercent } from './format';
import {
  APP_STATUS_ICON_CLASSNAME,
  APP_STATUS_ITEM_CLASSNAME,
  APP_STATUS_LABEL_CLASSNAME,
  SIDEBAR_FOOTER_ICON_CLASSNAME,
  SIDEBAR_FOOTER_ITEM_CLASSNAME,
  TITLEBAR_BUTTON_CLASSNAME,
} from '../sidebar/sidebar-styles';
import { TITLEBAR_CORNER_TRAILING_PX } from '../sidebar-layout';

export interface ResourceDiagnosticsPillProps {
  collapsed: boolean;
  /** True once the resource monitor store has received its first snapshot. */
  ready: boolean;
  statusBar?: boolean;
  compactLabel?: boolean;
}

type Tone = 'ok' | 'warning' | 'critical' | 'loading' | 'error';

interface ResourceDiagnosticsIconProps {
  tone?: Tone;
  size?: IconSize;
  testId?: string;
}

function formatMemoryGigabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0.0 GB';
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function toneClasses(tone: Tone): string {
  switch (tone) {
    case 'critical':
      return `${OPERATIONAL_STATUS_COLORS.failed.foreground} hover:bg-subtle`;
    case 'warning':
      return 'fg-warning hover:bg-subtle';
    case 'error':
      return `${OPERATIONAL_STATUS_COLORS.failed.foreground} hover:bg-subtle`;
    case 'loading':
      return 'fg-quaternary hover:bg-subtle';
    case 'ok':
    default:
      return `${OPERATIONAL_STATUS_COLORS.success.foreground} hover:bg-subtle`;
  }
}

export function ResourceDiagnosticsIcon({
  tone = 'ok',
  size = 'xl',
  testId = 'sidebar-resource-diagnostics-icon',
}: ResourceDiagnosticsIconProps): JSX.Element {
  const toneClassName =
    tone === 'critical' || tone === 'error'
      ? OPERATIONAL_STATUS_COLORS.failed.foreground
      : tone === 'warning'
        ? 'fg-warning'
        : tone === 'loading'
          ? 'fg-quaternary'
          : OPERATIONAL_STATUS_COLORS.success.foreground;

  return (
    <ResourceMonitorIcon
      size={size}
      className={toneClassName}
      aria-hidden="true"
      data-testid={testId}
    />
  );
}

export function ResourceDiagnosticsPill({
  collapsed,
  ready,
  statusBar = false,
  compactLabel = false,
}: ResourceDiagnosticsPillProps): JSX.Element {
  const snapshot = useResourceMonitorStore((s) => s.snapshot);
  const error = useResourceMonitorStore((s) => s.error);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // The trigger: measured for the compact layout, and where focus returns
  // when the panel closes (the anchor is the wrapper, which takes no focus).
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const compactIconRef = useRef<HTMLSpanElement | null>(null);
  const compactTextRef = useRef<HTMLSpanElement | null>(null);
  const compactCpuSegmentRef = useRef<HTMLSpanElement | null>(null);
  const compactMemoryRef = useRef<HTMLSpanElement | null>(null);
  const compactMeasureRef = useRef<(() => void) | null>(null);
  // Opening focuses the panel itself, not its first control: the settings
  // button's tooltip would otherwise open over the readings on every open.
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [compactLayout, setCompactLayout] =
    useState<CompactResourceLayout>('icon');

  const isLoading = !ready;
  const compactCpu =
    snapshot === null ? null : `${formatCpuPercent(snapshot.cpuPercent)}%`;
  const compactMemory =
    snapshot === null ? null : formatMemoryGigabytes(snapshot.memoryRssBytes);

  let tone: Tone;
  let primaryText: string;
  let title: string;

  if (isLoading) {
    tone = 'loading';
    primaryText = 'Measuring resources…';
    title = 'Measuring resources…';
  } else if (snapshot === null) {
    tone = 'error';
    primaryText = 'Resource metrics unavailable';
    title = 'Resource metrics unavailable';
  } else if (error !== null) {
    // We have a snapshot but the latest sample failed; show the error tone
    // while still surfacing the prior CPU/memory readings to the user.
    tone = 'error';
    const cpu = formatCpuPercent(snapshot.cpuPercent);
    const mem = formatMemoryGigabytes(snapshot.memoryRssBytes);
    primaryText = 'Resource metrics unavailable';
    title = `Resource metrics unavailable — last reading CPU ${cpu}%, Memory ${mem}`;
  } else {
    const pressureLevel = snapshot.pressure?.level ?? 'ok';
    if (pressureLevel === 'critical') {
      tone = 'critical';
    } else if (pressureLevel === 'warning') {
      tone = 'warning';
    } else {
      tone = 'ok';
    }
    const cpu = formatCpuPercent(snapshot.cpuPercent);
    const mem = formatMemoryGigabytes(snapshot.memoryRssBytes);
    primaryText = compactLabel
      ? `${cpu}% · ${mem}`
      : `CPU ${cpu}% · Mem. ${mem}`;
    title = `CPU ${cpu}%, memory ${mem}`;
  }

  const hasCompactMetrics =
    compactLabel &&
    !isLoading &&
    error === null &&
    compactCpu !== null &&
    compactMemory !== null;

  useLayoutEffect((): (() => void) | void => {
    if (!statusBar || !compactLabel) {
      return;
    }

    const button = buttonRef.current;
    const icon = compactIconRef.current;
    const text = compactTextRef.current;
    const cpuSegment = compactCpuSegmentRef.current;
    const memory = compactMemoryRef.current;
    const host = rootRef.current?.parentElement;
    if (!button || !icon || !text || !cpuSegment || !memory || !host) {
      setCompactLayout('icon');
      return;
    }

    const measure = (): void => {
      const buttonStyle = window.getComputedStyle(button);
      const paddingRight = Number.parseFloat(buttonStyle.paddingRight) || 0;
      const controlGap =
        Number.parseFloat(buttonStyle.columnGap || buttonStyle.gap) || 0;
      setCompactLayout(
        selectCompactResourceLayout({
          buttonRight: button.getBoundingClientRect().right,
          // The resource host starts immediately after the shared titlebar
          // corner spacer. Its exported trailing token is the exact rendered
          // distance from Forward's right edge to this host's left edge.
          forwardRight:
            host.getBoundingClientRect().left - TITLEBAR_CORNER_TRAILING_PX,
          paddingRight,
          iconWidth: icon.getBoundingClientRect().width,
          controlGap,
          cpuSegmentWidth: cpuSegment.getBoundingClientRect().width,
          memoryWidth: memory.getBoundingClientRect().width,
        }),
      );
    };

    compactMeasureRef.current = measure;
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return (): void => {
        if (compactMeasureRef.current === measure) {
          compactMeasureRef.current = null;
        }
      };
    }

    const observer = new ResizeObserver(measure);
    observer.observe(host);
    observer.observe(cpuSegment);
    observer.observe(memory);
    return (): void => {
      observer.disconnect();
      if (compactMeasureRef.current === measure) {
        compactMeasureRef.current = null;
      }
    };
  }, [compactLabel, statusBar]);

  useLayoutEffect((): void => {
    compactMeasureRef.current?.();
  }, [compactCpu, compactMemory, error, isLoading, primaryText]);

  return (
    <div
      ref={rootRef}
      className={
        statusBar
          ? compactLabel
            ? 'shrink-0'
            : 'min-w-0 max-w-full shrink-0'
          : undefined
      }
    >
      <Tooltip
        label={title}
        className={statusBar ? undefined : 'w-full'}
        disabled={!collapsed && !compactLabel}
        suppressed={open}
      >
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-label={title}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-testid="sidebar-resource-diagnostics-pill"
          data-tone={tone}
          data-compact-layout={
            statusBar && compactLabel ? compactLayout : undefined
          }
          className={`${
            statusBar
              ? compactLabel
                ? `${TITLEBAR_BUTTON_CLASSNAME} relative gap-1.5 whitespace-nowrap text-2xs font-normal`
                : `${APP_STATUS_ITEM_CLASSNAME} max-w-full`
              : SIDEBAR_FOOTER_ITEM_CLASSNAME
          } group ${statusBar ? '' : toneClasses(tone)}`}
        >
          <span
            ref={statusBar && compactLabel ? compactIconRef : undefined}
            className={
              statusBar
                ? compactLabel
                  ? 'order-2 inline-flex h-4 w-4 shrink-0 items-center justify-center'
                  : APP_STATUS_ICON_CLASSNAME
                : SIDEBAR_FOOTER_ICON_CLASSNAME
            }
          >
            {statusBar ? (
              compactLabel ? (
                <ChipSimpleIcon size={16} />
              ) : (
                <ResourceMonitorIcon size={14} />
              )
            ) : (
              <ResourceDiagnosticsIcon tone={tone} size="sm" />
            )}
          </span>
          <span
            ref={statusBar && compactLabel ? compactTextRef : undefined}
            aria-hidden={
              statusBar && compactLabel && compactLayout === 'icon'
                ? true
                : undefined
            }
            className={`text-left tabular-nums ${
              statusBar && compactLabel
                ? `order-1 shrink-0 whitespace-nowrap ${
                    compactLayout === 'icon'
                      ? 'pointer-events-none absolute invisible w-max'
                      : 'inline-flex'
                  }`
                : `min-w-0 flex-1 truncate ${
                    statusBar ? APP_STATUS_LABEL_CLASSNAME : ''
                  }`
            } ${collapsed ? 'w-0 opacity-0' : 'opacity-100'}`}
          >
            {compactLabel ? (
              <>
                <span
                  ref={statusBar ? compactCpuSegmentRef : undefined}
                  className={
                    !hasCompactMetrics
                      ? 'hidden'
                      : compactLayout === 'memory'
                        ? 'pointer-events-none absolute invisible w-max'
                        : undefined
                  }
                  data-testid={
                    hasCompactMetrics
                      ? 'sidebar-resource-diagnostics-cpu'
                      : undefined
                  }
                >
                  {hasCompactMetrics && (
                    <>
                      {compactCpu}
                      {'\u00a0·\u00a0'}
                    </>
                  )}
                </span>
                <span
                  ref={statusBar ? compactMemoryRef : undefined}
                  data-testid={
                    hasCompactMetrics
                      ? 'sidebar-resource-diagnostics-memory'
                      : undefined
                  }
                >
                  {hasCompactMetrics ? compactMemory : primaryText}
                </span>
              </>
            ) : (
              primaryText
            )}
          </span>
        </button>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={rootRef}
        returnFocusRef={buttonRef}
        initialFocusRef={panelRef}
        width="lg"
        aria-label="Resources"
        data-testid="resource-diagnostics-popover"
      >
        <div ref={panelRef} tabIndex={-1} className="outline-none">
          <ResourceDiagnosticsPopover
            snapshot={snapshot}
            error={error}
            onClose={() => setOpen(false)}
            loading={snapshot === null ? isLoading : false}
          />
        </div>
      </Popover>
    </div>
  );
}
