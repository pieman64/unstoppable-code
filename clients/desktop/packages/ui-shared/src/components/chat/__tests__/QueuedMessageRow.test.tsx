/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import {
  QueuedMessageRow,
  QUEUED_MESSAGE_BUSY_TOOLTIP,
  QUEUED_MESSAGE_EDITING_TOOLTIP,
  QUEUED_MESSAGE_SENDING_TOOLTIP,
  QUEUED_MESSAGE_TRAY_CLASS,
} from '../QueuedMessageRow';
import { SteeringRequestTitle } from '../SteeringRequestTitle';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

describe('QueuedMessageRow', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function click(testId: string): void {
    act(() =>
      document
        .querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)
        ?.click(),
    );
  }

  it('hides the message and its files from session replay, never its title or buttons', () => {
    act(() =>
      root.render(
        <QueuedMessageRow
          text="Private prompt"
          label={<span>Sent by Reviewer</span>}
          attachments={[
            { key: 'a', kind: 'image', name: 'shot.png', src: 'data:,' },
          ]}
          reorder={{ handleProps: {} }}
          onSteer={(): void => {}}
          onInterrupt={(): void => {}}
          onDelete={(): void => {}}
        />,
      ),
    );
    const blocked = (testId: string): boolean =>
      container
        .querySelector(`[data-testid="${testId}"]`)
        ?.closest('.ph-no-capture') instanceof Element;
    expect(blocked('queued-message-preview')).toBe(true);
    expect(blocked('queued-message-attachments')).toBe(true);
    // The leading title is never blocked: the agent sender title masks its
    // own text, and watcher and steering titles are product text.
    const title = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'Sent by Reviewer',
    );
    expect(title).toBeInstanceOf(Element);
    expect(title?.closest('.ph-no-capture')).toBeNull();
    for (const testId of [
      'queued-message-drag-handle',
      'queued-message-steer',
      'queued-message-interrupt',
      'queued-message-more',
    ]) {
      expect(
        container.querySelector(`[data-testid="${testId}"]`),
      ).toBeInstanceOf(Element);
      expect(blocked(testId)).toBe(false);
    }
  });

  it('shows the text, then Steer, Interrupt and a ••• menu', () => {
    const onSteer = jest.fn();
    const onInterrupt = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageRow
          text={'Run the tests\n\nthen   open a PR'}
          onEdit={(): void => {}}
          onSteer={onSteer}
          onInterrupt={onInterrupt}
          onDelete={(): void => {}}
        />,
      ),
    );
    const row = container.querySelector('[role="listitem"]');
    // No handle while the list cannot be reordered.
    expect(
      row?.querySelector('[data-testid="queued-message-drag-handle"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="queued-message-preview"]')
        ?.textContent,
    ).toBe('Run the tests then open a PR');
    // The message reads in the primary ink; the buttons stay a quieter grey
    // that hover lifts to the primary ink.
    expect(
      container.querySelector('[data-testid="queued-message-preview"]')
        ?.className,
    ).toContain('fg-primary');
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(
      buttons.map(
        (button) =>
          button.textContent?.trim() || button.getAttribute('aria-label'),
      ),
    ).toEqual(['Steer', 'Interrupt', 'More actions']);
    // Steer and Send now are the same quiet text button: no icon, no fill.
    for (const testId of ['queued-message-steer', 'queued-message-interrupt']) {
      const button = container.querySelector(`[data-testid="${testId}"]`);
      expect(button?.querySelector('svg')).toBeNull();
      expect(button?.className).toContain('bg-transparent');
      expect(button?.className).toContain('fg-secondary');
      expect(button?.className).toContain('hover:fg-primary');
    }
    // Delete and Edit live in the menu, not as row buttons.
    expect(
      row?.querySelector('[data-testid="queued-message-cancel"]'),
    ).toBeNull();
    expect(row?.querySelector('[data-glyph="pencil"]')).toBeNull();
    click('queued-message-interrupt');
    click('queued-message-steer');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onSteer).toHaveBeenCalledTimes(1);
    // The actions sit flush: no extra space before the •••.
    expect(
      container.querySelector('[data-testid="queued-message-more"]')?.className,
    ).not.toContain('ml-0.5');
  });

  it('keeps Edit message, then Delete below a divider, in the ••• menu', async () => {
    const onEdit = jest.fn();
    const onDelete = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageRow
          text="queued"
          onEdit={onEdit}
          onInterrupt={(): void => {}}
          onDelete={onDelete}
        />,
      ),
    );
    click('queued-message-more');
    const menu = document.querySelector(
      '[data-testid="queued-message-more-menu"]',
    );
    expect(
      Array.from(
        menu?.querySelectorAll('[role="menuitem"]') ?? [],
        (item) => item.textContent,
      ),
    ).toEqual(['Edit message', 'Delete']);
    expect(menu?.querySelector('[role="separator"]')).not.toBeNull();
    expect(
      menu?.querySelector('[data-testid="queued-message-interrupt"]'),
    ).toBeNull();
    click('queued-message-edit');
    // The pick runs after the menu returns focus to •••, so an editor it
    // opens keeps its focus.
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
    click('queued-message-more');
    click('queued-message-cancel');
    // Delete acts at once: a host deleting by position must not see the
    // queue change between the pick and the delete.
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('shows image and video thumbnails and file names before the text', () => {
    act(() =>
      root.render(
        <QueuedMessageRow
          text="Look at these"
          attachments={[
            {
              key: 'a',
              kind: 'image',
              name: 'shot.png',
              src: 'data:image/png;base64,AAAA',
            },
            {
              key: 'b',
              kind: 'video',
              name: 'demo.mp4',
              src: 'data:image/png;base64,FRAME',
            },
            { key: 'c', kind: 'file', name: 'notes.pdf' },
            { key: 'd', kind: 'file', name: 'extra.txt' },
          ]}
        />,
      ),
    );
    const items = Array.from(
      container.querySelectorAll('[data-testid="queued-message-attachment"]'),
    );
    expect(items.map((item) => item.getAttribute('data-kind'))).toEqual([
      'image',
      'video',
      'file',
    ]);
    // Square thumbnails; the picture fills the image tile.
    for (const tile of items.slice(0, 2)) {
      expect(tile.className).toContain('h-6');
      expect(tile.className).toContain('w-6');
    }
    expect(items[0]?.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,AAAA',
    );
    // A video's first frame is its preview: a plain square, like an image,
    // with no play glyph. Its name still says it is a video.
    expect(items[1]?.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/png;base64,FRAME',
    );
    expect(items[1]?.querySelector('[data-glyph="play"]')).toBeNull();
    expect(items[1]?.querySelector('svg')).toBeNull();
    expect(items[1]?.getAttribute('aria-label')).toBe('Video demo.mp4');
    // A file shows its icon and name.
    expect(items[2]?.textContent).toBe('notes.pdf');
    expect(items[2]?.querySelector('svg')).not.toBeNull();
    // The rest are counted, and everything sits before the text.
    const strip = container.querySelector(
      '[data-testid="queued-message-attachments"]',
    );
    expect(strip?.textContent).toContain('+1');
    const preview = container.querySelector(
      '[data-testid="queued-message-preview"]',
    );
    expect(
      strip && preview
        ? strip.compareDocumentPosition(preview) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
  });

  it('keeps a plain empty tile while a video has no frame', () => {
    act(() =>
      root.render(
        <QueuedMessageRow
          text="clip"
          attachments={[{ key: 'v', kind: 'video', name: 'clip.mov' }]}
        />,
      ),
    );
    const tile = container.querySelector(
      '[data-testid="queued-message-attachment"]',
    );
    expect(tile?.querySelector('img')).toBeNull();
    expect(tile?.querySelector('svg')).toBeNull();
    expect(tile?.getAttribute('aria-label')).toBe('Video clip.mov');
  });

  it('shows Interrupt alone on a row that cannot steer', () => {
    act(() =>
      root.render(
        <QueuedMessageRow text="watcher" onInterrupt={(): void => {}} />,
      ),
    );
    expect(
      Array.from(container.querySelectorAll('button'), (button) =>
        button.textContent?.trim(),
      ),
    ).toEqual(['Interrupt']);
  });

  it('leads with a quiet grip handle that drags the row', () => {
    const onPointerDown = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageRow
          text="queued"
          onDelete={(): void => {}}
          reorder={{ handleProps: { onPointerDown } }}
        />,
      ),
    );
    const handle = container.querySelector(
      '[data-testid="queued-message-drag-handle"]',
    );
    const row = container.querySelector('[role="listitem"]');
    // The leading slot, with the shared grip glyph.
    expect(row?.firstElementChild?.contains(handle ?? null)).toBe(true);
    expect(
      handle?.querySelector('[data-glyph="grip-vertical"]'),
    ).not.toBeNull();
    // The shared quiet icon button: a round hover that nests in any corner.
    expect(handle?.className).toContain('hover:bg-subtle');
    expect(handle?.className).toContain('rounded-full');
    expect(handle?.className).toContain('cursor-grab');
    // A real button, so it reorders from the keyboard too.
    expect(handle?.tagName).toBe('BUTTON');
    expect(handle?.getAttribute('aria-label')).toBe('Reorder queued message');
    const press = (target: Element | null): void => {
      act(() => {
        target?.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0 }),
        );
      });
    };
    press(handle);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
    // Only the handle drags: the text and the buttons keep their own presses.
    press(container.querySelector('[data-testid="queued-message-preview"]'));
    press(container.querySelector('[data-testid="queued-message-more"]'));
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it('draws its icons with a 1.5px stroke', () => {
    const html = renderToString(
      <QueuedMessageRow text="queued" onEdit={(): void => {}} />,
    );
    // 1.5px at 14px on Lucide's 24-unit grid.
    expect(html).toMatch(/stroke-width:2\.57/);
  });

  it('puts the waiting reason after the text in the same size and a quieter ink', () => {
    act(() =>
      root.render(
        <QueuedMessageRow
          text="queued"
          status="Sends as soon as the agent can take it."
        />,
      ),
    );
    const status = container.querySelector(
      '[data-testid="queued-message-status"]',
    );
    expect(status?.textContent).toBe('Sends as soon as the agent can take it.');
    expect(status?.className).toContain('fg-tertiary');
    expect(status?.className).not.toMatch(/text-(3xs|2xs|xs)\b/);
    // The slot centers its content on the row's axis; plain text still
    // truncates, in its own span.
    expect(status?.className).toContain('items-center');
    expect(status?.firstElementChild?.className).toContain('truncate');
  });

  it('masks the chat and project names in a watcher or steering title', () => {
    const watcher = renderToString(
      <QueuedMessageRow
        text="CI finished"
        watcherFired={{ kind: 'Chat "Billing fix" in Payments' }}
      />,
    );
    expect(watcher).toMatch(
      /<span class="[^"]*ph-mask[^"]*">Chat &quot;Billing fix&quot; in Payments watcher has fired<\/span>/,
    );
    expect(watcher).not.toContain('ph-no-capture flex min-w-0 max-w-1/2');
    const steering = renderToString(
      <SteeringRequestTitle requestedBy="Port handlers" layout="inline" />,
    );
    expect(steering).toMatch(
      /<span class="[^"]*ph-mask[^"]*">[^<]*Port handlers<\/span>/,
    );
  });

  it('labels a fired watcher inline instead of tinting the row', () => {
    const html = renderToString(
      <QueuedMessageRow
        text="CI finished"
        watcherFired={{ kind: 'Pipeline' }}
      />,
    );
    expect(html).toContain('data-testid="watcher-fired-title"');
    expect(html).toContain('Pipeline watcher has fired');
    expect(html).not.toContain('bg-info-subtle');
    expect(html).not.toContain('mb-1');
  });

  it('says why sending waits until the message is queued, and keeps ••• open', () => {
    const onEdit = jest.fn();
    const onSteer = jest.fn();
    const onInterrupt = jest.fn();
    const onDelete = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageRow
          text="queued"
          sending
          onEdit={onEdit}
          onSteer={onSteer}
          onInterrupt={onInterrupt}
          onDelete={onDelete}
        />,
      ),
    );
    const button = (testId: string): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    // Steer and Send now wait, and say so.
    for (const testId of ['queued-message-steer', 'queued-message-interrupt']) {
      expect(button(testId)).toBeInstanceOf(HTMLButtonElement);
      expect(button(testId)?.disabled).toBe(true);
    }
    expect(
      button('queued-message-interrupt')?.getAttribute('aria-description'),
    ).toBe(QUEUED_MESSAGE_SENDING_TOOLTIP);
    // ••• is never dimmed: it opens, with Edit message and Delete waiting
    // under the same reason.
    expect(button('queued-message-more')?.disabled).toBe(false);
    click('queued-message-more');
    expect(
      document.querySelector('[data-testid="queued-message-more-unavailable"]')
        ?.textContent,
    ).toBe(QUEUED_MESSAGE_SENDING_TOOLTIP);
    expect(button('queued-message-edit')?.disabled).toBe(true);
    expect(button('queued-message-cancel')?.disabled).toBe(true);
    click('queued-message-edit');
    click('queued-message-cancel');
    click('queued-message-interrupt');
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onInterrupt).not.toHaveBeenCalled();
    // A double-click does not open the editor either.
    act(() => {
      container
        .querySelector('[data-testid="queued-message-preview"]')
        ?.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, detail: 2 }),
        );
    });
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('enables every action once the message is queued', () => {
    act(() =>
      root.render(
        <QueuedMessageRow
          text="queued"
          onEdit={(): void => {}}
          onSteer={(): void => {}}
          onInterrupt={(): void => {}}
          onDelete={(): void => {}}
        />,
      ),
    );
    for (const button of Array.from(container.querySelectorAll('button'))) {
      expect(button.disabled).toBe(false);
    }
    click('queued-message-more');
    expect(
      document.querySelector('[data-testid="queued-message-more-unavailable"]'),
    ).toBeNull();
  });

  it('keeps Steer, Send now and the handle on a row that waits, quiet and saying why', () => {
    act(() =>
      root.render(
        <QueuedMessageRow
          text="queued"
          reorder={{
            handleProps: { onPointerDown: (): void => {} },
            unavailableReason: QUEUED_MESSAGE_EDITING_TOOLTIP,
          }}
          steerUnavailableReason={QUEUED_MESSAGE_BUSY_TOOLTIP}
          interruptUnavailableReason={QUEUED_MESSAGE_EDITING_TOOLTIP}
          onDelete={(): void => {}}
        />,
      ),
    );
    const button = (testId: string): HTMLButtonElement | null =>
      document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    for (const [testId, reason] of [
      ['queued-message-drag-handle', QUEUED_MESSAGE_EDITING_TOOLTIP],
      ['queued-message-steer', QUEUED_MESSAGE_BUSY_TOOLTIP],
      ['queued-message-interrupt', QUEUED_MESSAGE_EDITING_TOOLTIP],
    ] as const) {
      const element = button(testId);
      expect(element).toBeInstanceOf(HTMLButtonElement);
      expect(element?.disabled).toBe(true);
      expect(element?.getAttribute('aria-description')).toBe(reason);
      // Quiet: the quiet ghost, a dimmed label without the grey disabled fill.
      expect(element?.className).toContain('disabled:bg-transparent');
    }
    expect(button('queued-message-more')?.disabled).toBe(false);
  });

  it('draws the same quiet ••• on a ready row and a waiting one', () => {
    act(() =>
      root.render(
        <div>
          <QueuedMessageRow
            text="ready"
            onSteer={(): void => {}}
            onInterrupt={(): void => {}}
            onDelete={(): void => {}}
          />
          <QueuedMessageRow
            text="waiting"
            sending
            onInterrupt={(): void => {}}
            onDelete={(): void => {}}
          />
          <QueuedMessageRow
            text="editing elsewhere"
            steerUnavailableReason={QUEUED_MESSAGE_EDITING_TOOLTIP}
            interruptUnavailableReason={QUEUED_MESSAGE_EDITING_TOOLTIP}
            onDelete={(): void => {}}
          />
        </div>,
      ),
    );
    const mores = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="queued-message-more"]',
      ),
    );
    expect(mores).toHaveLength(3);
    expect(mores.map((more) => more.disabled)).toEqual([false, false, false]);
    expect(new Set(mores.map((more) => more.className)).size).toBe(1);
  });

  it('explains why Steer is unavailable for a capability change', () => {
    act(() =>
      root.render(
        <QueuedMessageRow text="queued" steerBlockedByCapabilityChange />,
      ),
    );
    const steer = container.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-steer"]',
    );
    expect(steer?.disabled).toBe(true);
    expect(steer?.getAttribute('aria-description')).toContain(
      'changes agent capabilities',
    );
  });

  it('warns what Steer and Interrupt do while new settings wait for background work', () => {
    act(() =>
      root.render(
        <QueuedMessageRow
          text="queued"
          settingsHeld={['plugins']}
          onSteer={jest.fn()}
          onInterrupt={jest.fn()}
        />,
      ),
    );
    const warning = container.querySelector(
      '[data-testid="queued-message-settings-held-warning"]',
    );
    expect(warning?.getAttribute('aria-description')).toContain(
      'Changed: plugins. Background work is still running, so these changes wait until it finishes. Steer adds this message to the current reply without them. Interrupt stops the reply',
    );

    // Run now sends without the new settings and stops nothing: no warning.
    act(() =>
      root.render(
        <QueuedMessageRow
          text="queued"
          settingsHeld={[]}
          forceKind="run-now"
          onInterrupt={jest.fn()}
        />,
      ),
    );
    expect(
      container.querySelector(
        '[data-testid="queued-message-settings-held-warning"]',
      ),
    ).toBeNull();
  });

  it('opens the editor on a double-click unless the host only advises a lock', () => {
    const onEdit = jest.fn();
    act(() => root.render(<QueuedMessageRow text="queued" onEdit={onEdit} />));
    const row = container.querySelector<HTMLElement>('[role="listitem"]');
    expect(row?.getAttribute('data-double-click-edit')).toBe('true');

    act(() =>
      root.render(
        <QueuedMessageRow text="queued" onEdit={onEdit} editLockAdvisory />,
      ),
    );
    expect(
      container
        .querySelector('[role="listitem"]')
        ?.getAttribute('data-double-click-edit'),
    ).toBeNull();
  });

  it('draws a card that tucks under the composer, inset by its corner radius', () => {
    // One surface step below the composer box (bg-tertiary), with a hairline.
    expect(QUEUED_MESSAGE_TRAY_CLASS).toContain('bg-secondary');
    expect(QUEUED_MESSAGE_TRAY_CLASS).toContain('ring-line-secondary');
    // The composer box is rounded-2xl: the card's top corners match it and
    // its sides sit that radius in, clear of the composer's corner curve.
    expect(QUEUED_MESSAGE_TRAY_CLASS).toContain('rounded-t-2xl');
    expect(QUEUED_MESSAGE_TRAY_CLASS).toContain('mx-5');
    // 8px visible below the last row plus the 16px tuck.
    expect(QUEUED_MESSAGE_TRAY_CLASS).toContain('pb-6');
    expect(QUEUED_MESSAGE_TRAY_CLASS).toContain('-mb-4');
  });

  it('shows a held row a disabled Retry that explains the hold and never sends', () => {
    const onInterrupt = jest.fn();
    const onSteer = jest.fn();
    const onDelete = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageRow
          text="Held prompt"
          sendBlockedReason="insufficient_credits"
          onSteer={onSteer}
          onInterrupt={onInterrupt}
          onDelete={onDelete}
        />,
      ),
    );
    const send = document.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-interrupt"]',
    );

    expect(send?.textContent).toBe('Try again');
    expect(send?.getAttribute('aria-disabled')).toBe('true');
    expect(send?.getAttribute('aria-description')).toBe(
      'Your queued message is saved. Try again sends it once your account has AI credits.',
    );
    expect(document.querySelector('[data-testid="queued-message-steer"]')).toBe(
      null,
    );
    click('queued-message-interrupt');
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(onSteer).not.toHaveBeenCalled();

    // Delete stays available while the row is held.
    click('queued-message-more');
    click('queued-message-cancel');
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('sends once from Send now after the hold lifts', () => {
    const onInterrupt = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageRow
          text="Held prompt"
          sendBlockedReason="insufficient_credits"
          onInterrupt={onInterrupt}
        />,
      ),
    );
    click('queued-message-interrupt');
    act(() =>
      root.render(
        <QueuedMessageRow text="Held prompt" onInterrupt={onInterrupt} />,
      ),
    );
    const send = document.querySelector(
      '[data-testid="queued-message-interrupt"]',
    );
    expect(send?.hasAttribute('aria-disabled')).toBe(false);
    click('queued-message-interrupt');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('keeps a drawer Retry blocked until credits arrive, then sends once', () => {
    const onInterrupt = jest.fn();
    const row = (held: boolean): JSX.Element => (
      <QueuedMessageRow
        surface="drawer"
        forceKind="retry"
        text="Held drawer prompt"
        sendBlockedReason={held ? 'insufficient_credits' : undefined}
        onInterrupt={onInterrupt}
      />
    );
    act(() => root.render(row(true)));
    click('queued-message-more');
    const retry = document.querySelector<HTMLButtonElement>(
      '[data-testid="queued-message-retry"]',
    );
    expect(retry?.textContent).toContain('Try again');
    expect(retry?.disabled).toBe(true);
    click('queued-message-retry');
    expect(onInterrupt).not.toHaveBeenCalled();
    act(() => root.render(row(false)));
    // Re-open if the disabled item closed the menu.
    if (!document.querySelector('[data-testid="queued-message-retry"]')) {
      click('queued-message-more');
    }
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="queued-message-retry"]',
      )?.disabled,
    ).toBe(false);
    click('queued-message-retry');
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it('keeps drawer Interrupt in the menu and dispatches its existing handler', () => {
    const interrupt = jest.fn();
    act(() =>
      root.render(
        <QueuedMessageRow
          surface="drawer"
          text="Run tests"
          onInterrupt={interrupt}
          onEdit={jest.fn()}
          onDelete={jest.fn()}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="queued-message-interrupt"]'),
    ).toBeNull();
    click('queued-message-more');
    expect(
      document.querySelector('[data-testid="queued-message-copy"]'),
    ).not.toBeNull();
    click('queued-message-interrupt');
    expect(interrupt).toHaveBeenCalledTimes(1);
  });
});
