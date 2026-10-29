import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';

/**
 * Collects the pushes a controller should see and forwards each once per
 * controller window.
 *
 * A controlled computer's main process reaches its renderers three ways:
 * broadcasts to every window, sends to the main window only, and replies to
 * the window that made a call. A remote session sees all three by watching
 * the main window and one bridge per controller window. A bridge's push goes
 * to that bridge's window; a push seen in the main window goes to every
 * controller window. A broadcast reaches the main window and the bridges in
 * the same synchronous loop with the same argument objects, so an offer
 * identical to one already made in this tick is the same broadcast, and each
 * controller window receives it once.
 */
export interface PushForwarder {
  /** `surface` names the bridge that saw the push; absent for the main window. */
  offer(
    channel: string,
    args: ReadonlyArray<unknown>,
    surface?: RemoteSurface,
  ): void;
}

interface RecentPush {
  channel: string;
  args: ReadonlyArray<unknown>;
  /** Controller windows that already received it, or all of them. */
  covered: Set<RemoteSurface> | 'all';
}

function sameArgs(
  left: ReadonlyArray<unknown>,
  right: ReadonlyArray<unknown>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

export function createPushForwarder(
  /** `surface` absent sends to every controller window. */
  forward: (channel: string, args: unknown[], surface?: RemoteSurface) => void,
  scheduleClear: (callback: () => void) => void = (callback) => {
    setImmediate(callback);
  },
  /** Controller windows that have a bridge. */
  surfaces: () => ReadonlyArray<RemoteSurface> = () => ['main'],
  onDuplicateDrop: () => void = () => undefined,
): PushForwarder {
  let recent: RecentPush[] = [];
  let clearScheduled = false;
  const remember = (push: RecentPush): void => {
    recent.push(push);
    if (!clearScheduled) {
      clearScheduled = true;
      scheduleClear(() => {
        recent = [];
        clearScheduled = false;
      });
    }
  };
  return {
    offer(
      channel: string,
      args: ReadonlyArray<unknown>,
      surface?: RemoteSurface,
    ): void {
      const seen = recent.find(
        (push) => push.channel === channel && sameArgs(push.args, args),
      );
      if (!seen) {
        remember({
          channel,
          args,
          covered: surface === undefined ? 'all' : new Set([surface]),
        });
        forward(channel, [...args], surface);
        return;
      }
      const covered = seen.covered;
      if (covered === 'all') {
        onDuplicateDrop();
        return;
      }
      if (surface !== undefined) {
        if (covered.has(surface)) {
          onDuplicateDrop();
          return;
        }
        covered.add(surface);
        forward(channel, [...args], surface);
        return;
      }
      let forwarded = false;
      for (const remaining of surfaces()) {
        if (!covered.has(remaining)) {
          forward(channel, [...args], remaining);
          forwarded = true;
        }
      }
      if (!forwarded) onDuplicateDrop();
      seen.covered = 'all';
    },
  };
}
