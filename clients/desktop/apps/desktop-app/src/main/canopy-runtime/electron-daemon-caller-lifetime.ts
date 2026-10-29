/**
 * The document lifetime that owns a trusted caller's daemon session.
 *
 * One owner signal per sender object (a renderer `WebContents`). Its current
 * document retires, aborting the signal, when the sender is destroyed, its
 * renderer process is gone, or a main-frame navigation commits. A navigation
 * that starts but never commits, a same-document navigation and subframe
 * navigations leave it current. Nothing is keyed by principal or numeric id,
 * so a sender that reuses a destroyed sender's id holds its own owner.
 */

export type CallerLifetimeEvent =
  | 'destroyed'
  | 'render-process-gone'
  | 'did-navigate';

export interface CallerLifetimeSender {
  isDestroyed(): boolean;
  on(event: CallerLifetimeEvent, listener: () => void): unknown;
  removeListener(event: CallerLifetimeEvent, listener: () => void): unknown;
}

export interface ElectronDaemonCallerLifetime {
  /** The sender's current document owner; already aborted once it is gone. */
  ownerFor(sender: CallerLifetimeSender): AbortSignal;
  /**
   * Aborts every current owner without retiring documents; each sender's next
   * `ownerFor` returns a fresh owner. Closes sessions when a route turns off.
   */
  renewAll(): void;
  /** Quit: retires every document and refuses new owners. */
  disposeAll(): void;
}

// `did-navigate` fires for committed main-frame loads only; in-page and
// subframe navigations use other events.
const RETIRING_EVENTS: readonly CallerLifetimeEvent[] = [
  'destroyed',
  'render-process-gone',
  'did-navigate',
];

function closedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

export function createElectronDaemonCallerLifetime(): ElectronDaemonCallerLifetime {
  interface Entry {
    controller: AbortController;
    detach: () => void;
  }
  const entries = new Map<CallerLifetimeSender, Entry>();
  let disposed = false;

  const retire = (sender: CallerLifetimeSender): void => {
    const entry = entries.get(sender);
    if (!entry) return;
    entries.delete(sender);
    entry.detach();
    entry.controller.abort();
  };

  return {
    ownerFor(sender): AbortSignal {
      if (disposed || sender.isDestroyed()) {
        retire(sender);
        return closedSignal();
      }
      const existing = entries.get(sender);
      if (existing) return existing.controller.signal;
      const onRetire = (): void => retire(sender);
      const entry: Entry = {
        controller: new AbortController(),
        detach: (): void => {
          for (const event of RETIRING_EVENTS)
            sender.removeListener(event, onRetire);
        },
      };
      for (const event of RETIRING_EVENTS) sender.on(event, onRetire);
      entries.set(sender, entry);
      return entry.controller.signal;
    },
    renewAll(): void {
      entries.forEach((entry) => {
        const previous = entry.controller;
        entry.controller = new AbortController();
        previous.abort();
      });
    },
    disposeAll(): void {
      disposed = true;
      for (const sender of Array.from(entries.keys())) retire(sender);
    },
  };
}
