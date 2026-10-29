'use client';

import { useEffect, useLayoutEffect, useState, type JSX } from 'react';

/** Samples kept; more than the widest composer can show at one per 3px. */
const HISTORY = 480;
/** Below this a sample reads as silence and draws as a dot. */
const SPEECH_FLOOR = 0.12;
const BAR_WIDTH = 1;
const BAR_GAP = 2;
const BAR_HEIGHT = 20;
/** Silence keeps a 2px dot so a 1px-wide line stays visible. */
const REST_SCALE = 2 / BAR_HEIGHT;

export interface AudioWaveformProps {
  /**
   * The loudest level (0 to 1) since the previous call. Polled once per
   * sample, so the source can collect peaks at its own rate.
   */
  readLevel: () => number;
  /** How often a new sample scrolls in, in ms. */
  sampleMs?: number;
  /** Freezes the waveform (for example, while a recording is paused). */
  paused?: boolean;
  dataTestId?: string;
}

/**
 * A live recording waveform that fills its slot: the newest sample enters on
 * the right and history drifts left, fading out at both ends. Silence draws as
 * quiet dots and speech as 1px bars. Bars scale with `transform`, so a new
 * sample never re-lays out the row around it.
 */
export function AudioWaveform({
  readLevel,
  sampleMs = 120,
  paused = false,
  dataTestId,
}: AudioWaveformProps): JSX.Element {
  const [levels, setLevels] = useState<number[]>(() =>
    Array.from({ length: HISTORY }, (): number => 0),
  );
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [slots, setSlots] = useState(0);

  useLayoutEffect(() => {
    if (!node) return undefined;
    const measure = (): void => {
      setSlots(
        Math.max(
          0,
          Math.floor((node.clientWidth + BAR_GAP) / (BAR_WIDTH + BAR_GAP)),
        ),
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return (): void => observer.disconnect();
  }, [node]);

  useEffect(() => {
    if (paused) return undefined;
    const id = window.setInterval((): void => {
      const level = Math.min(1, Math.max(0, readLevel()));
      // Ease toward the new level, as a meter's envelope does, so
      // neighbouring bars rise and fall together instead of flickering.
      setLevels((previous) => {
        const last = previous[previous.length - 1] ?? 0;
        return [...previous.slice(1), last * 0.35 + level * 0.65];
      });
    }, sampleMs);
    return (): void => window.clearInterval(id);
  }, [paused, readLevel, sampleMs]);

  const shown = levels.slice(levels.length - Math.min(slots, HISTORY));
  return (
    <div
      ref={setNode}
      aria-hidden
      data-testid={dataTestId}
      className="flex h-8 min-w-0 flex-1 items-center justify-end gap-0.5 overflow-hidden"
      // Both ends fade over 24px instead of cutting bars off.
      style={{
        maskImage:
          'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)',
      }}
    >
      {shown.map((level, index) => {
        const speaking = level >= SPEECH_FLOOR;
        return (
          <span
            // Slots are positional: each shows whatever sample scrolled in.
            key={index}
            data-waveform-bar={speaking ? 'speech' : 'quiet'}
            className={`w-px shrink-0 rounded-full bg-current transition-transform duration-100 motion-reduce:transition-none ${
              speaking ? 'fg-secondary' : 'fg-quaternary'
            }`}
            style={{
              height: BAR_HEIGHT,
              transform: `scaleY(${speaking ? Math.max(REST_SCALE, level) : REST_SCALE})`,
            }}
          />
        );
      })}
    </div>
  );
}
