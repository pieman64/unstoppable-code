import type { CanopyDaemonClock } from '@canopy/core-runtime/node';
import type { CanopyByteChannel } from '@canopy/core-transport/types';

export function manualClock(): CanopyDaemonClock & {
  advance(ms: number): Promise<void>;
} {
  let now = Date.parse('2026-10-09T12:00:00Z');
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer(run, delayMs): { cancel(): void } {
      const timer = { at: now + delayMs, run };
      timers.add(timer);
      return { cancel: () => void timers.delete(timer) };
    },
    async advance(ms): Promise<void> {
      now += ms;
      for (;;) {
        const [due] = Array.from(timers)
          .filter(({ at }) => at <= now)
          .sort((a, b) => a.at - b.at);
        if (!due) break;
        timers.delete(due);
        due.run();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

export async function echo(channel: CanopyByteChannel): Promise<void> {
  try {
    for (let chunk = await channel.read(); chunk; chunk = await channel.read())
      await channel.write(chunk);
  } catch {
    // The channel closed mid-echo.
  }
}

export const HOLD = { accept: (): void => undefined };
