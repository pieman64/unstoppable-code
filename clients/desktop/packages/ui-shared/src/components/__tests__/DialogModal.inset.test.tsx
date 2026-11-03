/** @jest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DialogModal } from '../DialogModal';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;

function render(node: ReactNode): void {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function classesOf(selector: string): string[] {
  return (document.querySelector(selector)?.getAttribute('class') ?? '')
    .split(' ')
    .filter(Boolean);
}

const headerOf = (): string[] => {
  const title = document.querySelector('h2');
  const header = title?.parentElement?.parentElement;
  return (header?.getAttribute('class') ?? '').split(' ').filter(Boolean);
};

describe('DialogModal inset', () => {
  it('owns one 24px inset and a 16px block gap by default', () => {
    render(
      <DialogModal title="Rename" onClose={() => undefined} footer={<span />}>
        <p data-testid="field">Name</p>
      </DialogModal>,
    );
    expect(headerOf()).toEqual(
      expect.arrayContaining(['px-6', 'pt-6', 'pb-4']),
    );
    expect(headerOf()).not.toContain('p-5');
    const body = document.querySelector('[data-testid="field"]')?.parentElement;
    expect((body?.getAttribute('class') ?? '').split(' ')).toEqual(
      expect.arrayContaining([
        'flex',
        'flex-col',
        'gap-4',
        'px-6',
        'pt-6',
        'pb-1',
      ]),
    );
    expect(classesOf('[data-dialog-footer]')).toEqual(
      expect.arrayContaining(['px-6', 'pb-6', 'pt-4']),
    );
  });

  it('lets a scrolling owned body fill a fixed-height card', () => {
    render(
      <DialogModal title="Worker" onClose={() => undefined} height="86vh">
        <div data-testid="fill" className="flex min-h-0 flex-1 flex-col" />
      </DialogModal>,
    );
    const body = document.querySelector('[data-testid="fill"]')?.parentElement;
    const classes = (body?.getAttribute('class') ?? '').split(' ');
    // Grows into the scroller so flex-1 and h-full children get a height,
    // but keeps its content height (no min-h-0) so long bodies still scroll.
    expect(classes).toContain('flex-1');
    expect(classes).not.toContain('min-h-0');
  });

  it('ends the owned body on the 24px inset without a footer or divider', () => {
    render(
      <DialogModal
        title="Rename"
        onClose={() => undefined}
        headerBorder={false}
        scrollableBody={false}
      >
        <p data-testid="field">Name</p>
      </DialogModal>,
    );
    const body = document.querySelector('[data-testid="field"]')?.parentElement;
    const classes = (body?.getAttribute('class') ?? '').split(' ');
    expect(classes).toEqual(expect.arrayContaining(['px-6', 'pb-6']));
    expect(classes).not.toContain('pt-6');
  });

  it('puts header and footer on the 24px inset but leaves a flush body to the caller', () => {
    render(
      <DialogModal
        title="Rename"
        onClose={() => undefined}
        inset="flush"
        footer={<span />}
      >
        <p data-testid="field">Name</p>
      </DialogModal>,
    );
    expect(headerOf()).toEqual(expect.arrayContaining(['px-6', 'pt-6']));
    expect(classesOf('[data-dialog-footer]')).toEqual(
      expect.arrayContaining(['px-6', 'pb-6', 'pt-4']),
    );
    expect(document.querySelector('[data-testid="field"]')?.parentElement).toBe(
      document.querySelector('[data-dialog-body]'),
    );
  });
});
