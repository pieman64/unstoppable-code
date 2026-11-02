/**
 * @jest-environment jsdom
 *
 * CAN-1521. The load-bearing property here is that the control NEVER leaves
 * the accessibility tree or the tab order: it is always mounted, never `hidden`
 * or `display: none`. A regression to
 * conditional rendering would be invisible to a screenshot test but would make
 * the feature unreachable by keyboard and screen reader.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TurnFeedbackControl } from '../TurnFeedbackControl';
import { ChatLookProvider } from '../chat-look';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(node: JSX.Element): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return { container, root };
}

function buttons(container: HTMLElement): {
  up: HTMLButtonElement;
  down: HTMLButtonElement;
} {
  const up = container.querySelector<HTMLButtonElement>(
    '[data-testid="turn-feedback-up"]',
  );
  const down = container.querySelector<HTMLButtonElement>(
    '[data-testid="turn-feedback-down"]',
  );
  if (!up || !down) {
    throw new Error('turn feedback buttons missing from the DOM');
  }
  return { up, down };
}

describe('TurnFeedbackControl', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('mounts both buttons with aria-pressed at rest, never hidden', () => {
    const { container } = render(
      <ChatLookProvider value="classic">
        <TurnFeedbackControl onRate={(): void => undefined} />
      </ChatLookProvider>,
    );
    const { up, down } = buttons(container);

    expect(up.getAttribute('aria-pressed')).toBe('false');
    expect(down.getAttribute('aria-pressed')).toBe('false');
    // Present in the accessibility tree and the tab order.
    expect(up.hasAttribute('hidden')).toBe(false);
    expect(down.hasAttribute('hidden')).toBe(false);
    expect(up.style.display).not.toBe('none');
    expect(down.style.display).not.toBe('none');

    const group = container.querySelector<HTMLElement>(
      '[data-testid="turn-feedback-control"]',
    );
    // CAN-4278: always visible next to the stamp, as plain icon buttons in
    // the stamp's muted tone, with no border or background at rest.
    expect(group?.className).not.toContain('opacity');
    for (const button of [up, down]) {
      const classes = button.className.split(/\s+/);
      expect(classes).toContain('fg-quaternary');
      expect(classes).toContain('focus-ring');
      expect(classes).toContain('h-6');
      expect(classes).toContain('pointer-coarse:h-11');
      expect(classes).toContain('pointer-coarse:w-11');
      expect(classes.some((cls) => /^(border|bg-)/.test(cls))).toBe(false);
    }
    expect(group?.getAttribute('data-rating')).toBe('none');
  });

  it('shows the rating by tone and a filled icon, never a border', () => {
    const { container } = render(
      <ChatLookProvider value="classic">
        <TurnFeedbackControl
          rating="down"
          syncState="pending"
          onRate={(): void => undefined}
        />
      </ChatLookProvider>,
    );
    const { up, down } = buttons(container);

    expect(down.getAttribute('aria-pressed')).toBe('true');
    expect(up.getAttribute('aria-pressed')).toBe('false');

    const group = container.querySelector<HTMLElement>(
      '[data-testid="turn-feedback-control"]',
    );
    const selected = down.className.split(/\s+/);
    expect(selected).toContain('fg-primary');
    expect(selected).toContain('pointer-coarse:h-11');
    expect(selected).toContain('pointer-coarse:w-11');
    expect(selected.some((cls) => /^(border|bg-)/.test(cls))).toBe(false);
    expect(down.querySelector('svg')?.getAttribute('fill')).toBe(
      'currentColor',
    );
    expect(up.querySelector('svg')?.getAttribute('fill')).not.toBe(
      'currentColor',
    );
    expect(group?.getAttribute('data-rating')).toBe('down');
    expect(group?.getAttribute('data-sync-state')).toBe('pending');
  });

  it('renders a failed upload as still rated', () => {
    // A rejected upload must never silently revert the user's click; the
    // outbox retries it on the next sign-in or startup flush.
    const { container } = render(
      <ChatLookProvider value="classic">
        <TurnFeedbackControl
          rating="up"
          syncState="failed"
          onRate={(): void => undefined}
        />
      </ChatLookProvider>,
    );
    const { up } = buttons(container);

    expect(up.getAttribute('aria-pressed')).toBe('true');
    expect(
      container
        .querySelector('[data-testid="turn-feedback-control"]')
        ?.getAttribute('data-rating'),
    ).toBe('up');
  });

  it('reports the picked rating, and clears when the selected one is clicked', () => {
    const rates: (string | null)[] = [];
    const { container, root } = render(
      <ChatLookProvider value="classic">
        <TurnFeedbackControl
          onRate={(next): void => {
            rates.push(next);
          }}
        />
      </ChatLookProvider>,
    );

    act(() => {
      buttons(container).down.click();
    });
    expect(rates).toEqual(['down']);

    act(() => {
      root.render(
        <ChatLookProvider value="classic">
          <TurnFeedbackControl
            rating="down"
            onRate={(next): void => {
              rates.push(next);
            }}
          />
        </ChatLookProvider>,
      );
    });
    act(() => {
      buttons(container).down.click();
    });
    expect(rates).toEqual(['down', null]);
  });
});
