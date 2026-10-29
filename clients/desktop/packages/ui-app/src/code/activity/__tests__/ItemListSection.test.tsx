/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { ItemListSection } from '../sections/ItemListSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('ItemListSection', () => {
  it('renders an empty label when there are no items', () => {
    const out = renderToString(
      <ItemListSection items={[]} emptyLabel="No plans." dataTestId="x" />,
    );
    expect(out).toContain('No plans.');
    expect(out).toContain('data-testid="x-empty"');
  });

  it('renders items with labels, details, and status chips', () => {
    const out = renderToString(
      <ItemListSection
        dataTestId="x"
        emptyLabel="none"
        items={[
          { key: '1', label: 'deploy', status: 'running', detail: 'step 2/5' },
          { key: '2', label: 'lint', status: 'failed' },
        ]}
      />,
    );
    expect(out).toContain('data-testid="x"');
    expect(out).toContain('deploy');
    expect(out).toContain('step 2/5');
    expect(out).toContain('running');
    expect(out).toContain('failed');
    // running → sky tone, failed → rose tone
    expect(out).toContain('fg-info');
    expect(out).toContain('fg-destructive-strong');
  });

  it('suppresses the list marker and zeroes list padding/margin', () => {
    const out = renderToString(
      <ItemListSection
        dataTestId="x"
        emptyLabel="none"
        items={[{ key: '1', label: 'deploy' }]}
      />,
    );
    const ulClass = /<ul class="([^"]*)"/.exec(out)?.[1] ?? '';
    expect(ulClass).toContain('list-none');
    expect(ulClass).toContain('m-0');
    expect(ulClass).toContain('p-0');
  });

  it('renders each row with the desktop Scripts/Hooks card classes', () => {
    const out = renderToString(
      <ItemListSection
        dataTestId="x"
        emptyLabel="none"
        items={[{ key: '1', label: 'deploy', dataTestId: 'row' }]}
      />,
    );
    const liClass =
      /<li class="([^"]*)"[^>]*data-testid="row"/.exec(out)?.[1] ?? '';
    expect(liClass).toContain('rounded-lg');
    expect(liClass).toContain('border');
    expect(liClass).not.toContain('border-border');
    expect(liClass).toContain('bg-fg-primary/[0.03]');
    expect(liClass).toContain('px-2.5');
    expect(liClass).toContain('py-2');
    // Medium foreground/80 label.
    expect(out).toContain('font-medium fg-primary/80');
  });

  it('renders primary, destructive, and default action geometry', () => {
    const out = renderToString(
      <ItemListSection
        dataTestId="x"
        emptyLabel="none"
        items={[
          {
            key: 'run',
            label: 'Build',
            actionLabel: 'Run',
            actionVariant: 'primary',
            onAction: (): void => {},
          },
          {
            key: 'stop',
            label: 'Build',
            actionLabel: 'Stop',
            actionVariant: 'destructive',
            onAction: (): void => {},
          },
          {
            key: 'open',
            label: 'Terminal',
            actionLabel: 'Open',
            onAction: (): void => {},
          },
        ]}
      />,
    );
    // Primary Run: shared 28px execution action, no border.
    expect(out).toContain(
      'h-7 rounded-md bg-accent px-2.5 text-xs font-normal',
    );
    // Destructive Stop: px-2 py-0.5 borderless rose.
    expect(out).toContain('px-2 py-0.5 text-2xs font-medium fg-destructive');
    // Default Open still carries the pill shape.
    expect(out).toContain('h-6');
    expect(out).not.toContain('border-border');
  });

  it('omits the action control when no handler is supplied', () => {
    const out = renderToString(
      <ItemListSection
        dataTestId="x"
        emptyLabel="none"
        items={[{ key: '1', label: 'deploy', actionLabel: 'Run' }]}
      />,
    );
    expect(out).not.toContain('>Run<');
  });

  it('renders the disabled state and blocks its dispatch', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onAction = jest.fn();
    act(() => {
      root.render(
        <ItemListSection
          dataTestId="x"
          emptyLabel="none"
          items={[
            {
              key: '1',
              label: 'deploy',
              actionLabel: 'Run',
              actionVariant: 'primary',
              actionDisabled: true,
              onAction,
            },
          ]}
        />,
      );
    });
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Run',
    );
    expect(button?.disabled).toBe(true);
    act(() => button?.click());
    expect(onAction).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it('dispatches the action and stops propagation to the row', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onAction = jest.fn();
    const onRowClick = jest.fn();
    act(() => {
      root.render(
        <div onClick={onRowClick}>
          <ItemListSection
            dataTestId="x"
            emptyLabel="none"
            items={[
              {
                key: '1',
                label: 'deploy',
                actionLabel: 'Stop',
                actionVariant: 'destructive',
                onAction,
              },
            ]}
          />
        </div>,
      );
    });
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Stop',
    );
    act(() => button?.click());
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });
});
