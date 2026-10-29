/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SubagentsViewProvider } from '@canopy/ui-shared/components';
import { StopAllDelegatesControl } from '../StopAllDelegatesControl';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('StopAllDelegatesControl', () => {
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

  function stopAllClasses(subagentsView: boolean): string[] {
    act(() =>
      root.render(
        <SubagentsViewProvider value={subagentsView}>
          <StopAllDelegatesControl
            liveDelegationIds={['delegation-1']}
            onStopAll={(): Promise<boolean> => Promise.resolve(true)}
          />
        </SubagentsViewProvider>,
      ),
    );
    return (
      container
        .querySelector('[data-testid="agent-activity-stop-all"]')
        ?.className.split(/\s+/) ?? []
    );
  }

  it('rests as a quiet red ghost under the Subagents view', () => {
    const classes = stopAllClasses(true);
    expect(classes).toEqual(
      expect.arrayContaining([
        'h-7',
        'fg-destructive',
        'hover:bg-destructive-subtle',
      ]),
    );
    expect(classes).not.toContain('fg-secondary');
  });

  it('keeps the classic small destructive action while the view is off', () => {
    const classes = stopAllClasses(false);
    expect(classes).toEqual(
      expect.arrayContaining(['fg-destructive', 'text-2xs']),
    );
    expect(classes).not.toContain('h-7');
  });
});
