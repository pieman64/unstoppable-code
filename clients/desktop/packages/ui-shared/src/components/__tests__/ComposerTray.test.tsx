/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatComposerShell } from '../ChatComposerShell';
import { ComposerDrawer, ComposerDrawerSection } from '../ComposerDrawer';
import {
  ComposerTray,
  ComposerTrayHost,
  ComposerTrayProvider,
} from '../ComposerTray';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function Surface({
  queued,
  drawer,
}: {
  readonly queued: boolean;
  readonly drawer: boolean;
}): JSX.Element {
  return (
    <ComposerTrayProvider>
      {queued ? (
        <ComposerTray>
          <div data-testid="queue-card" />
        </ComposerTray>
      ) : null}
      <ComposerTrayHost active>
        <div data-testid="composer-root">
          <ComposerDrawer edge="top" data-testid="drawer">
            {drawer ? (
              <ComposerDrawerSection>Background work</ComposerDrawerSection>
            ) : null}
          </ComposerDrawer>
          <ChatComposerShell dataTestId="box">
            <textarea aria-label="Message" />
          </ChatComposerShell>
        </div>
      </ComposerTrayHost>
    </ComposerTrayProvider>
  );
}

describe('ComposerTray', () => {
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
  const byTestId = (testId: string): Element | null =>
    container.querySelector(`[data-testid="${testId}"]`);

  it('adds no markup to a composer with nothing in its tray', () => {
    act(() => root.render(<Surface queued={false} drawer />));
    expect(container.querySelector('[data-composer-tray-slot]')).toBeNull();
    // A top drawer still sits right on the box.
    expect(byTestId('drawer')?.nextElementSibling).toBe(byTestId('box'));
  });

  it('lands the tray above a top drawer, which tucks over it, rather than between the drawer and the box', () => {
    act(() => root.render(<Surface queued drawer />));
    const card = byTestId('queue-card');
    expect(card).toBeInstanceOf(Element);
    const slot = card?.parentElement;
    expect(slot?.hasAttribute('data-composer-tray-slot')).toBe(true);
    expect(slot?.nextElementSibling).toBe(byTestId('drawer'));
    expect(
      container.querySelectorAll('[data-testid="queue-card"]'),
    ).toHaveLength(1);
  });

  it('takes the content back out of the composer when the tray empties', () => {
    act(() => root.render(<Surface queued drawer />));
    act(() => root.render(<Surface queued={false} drawer />));
    expect(byTestId('queue-card')).toBeNull();
    expect(container.querySelector('[data-composer-tray-slot]')).toBeNull();
  });
});
