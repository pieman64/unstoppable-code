import type { JSX, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as UiSharedComponents from '@canopy/ui-shared/components';
import { RunOutputModal } from '../RunOutputModal';

// DialogModal portals into document.body, which the server renderer cannot
// do. The dialog shell is not under test here; its body layout is.
jest.mock('@canopy/ui-shared/components', () => {
  const actual = jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  );
  return {
    ...actual,
    DialogModal: ({ children }: { children: ReactNode }): JSX.Element => (
      <div data-testid="dialog-shell">{children}</div>
    ),
  };
});

function renderModal(
  outputLines: readonly string[],
  status: 'active' | 'success' | 'paused' | 'failed' = 'active',
): string {
  return renderToStaticMarkup(
    <RunOutputModal
      title="Build"
      subtitle="Running…"
      titleId="run-output-title"
      statusLabel="Running…"
      status={status}
      durationMs={0}
      outputLines={outputLines}
      isRunning
      onClose={(): void => undefined}
      searchSlot={<input data-testid="search" />}
      emptyText="No output yet"
    />,
  );
}

function classesOf(markup: string, testId: string): string[] {
  // Attribute order follows the JSX, so find the tag first, then its class.
  const tag = new RegExp(`<div[^>]*data-testid="${testId}"[^>]*>`).exec(markup);
  const match = /class="([^"]*)"/.exec(tag?.[0] ?? '');
  return (match?.[1] ?? '').split(/\s+/).filter(Boolean);
}

describe('RunOutputModal', () => {
  it('runs the log edge to edge below the inset controls', () => {
    const markup = renderModal(['> npm run build', 'done']);
    const output = classesOf(markup, 'ansi-output');

    // The reader variant has no radius or outline of its own: the dialog clips
    // it, so the log shares the dialog's bottom corners.
    expect(output).toEqual(
      expect.arrayContaining(['px-5', 'py-4', 'min-h-0', 'flex-1']),
    );
    expect(output.some((name) => name.startsWith('rounded'))).toBe(false);
    expect(output.some((name) => name.startsWith('border'))).toBe(false);

    // The status row and the search keep the dialog's 20px column, and the
    // wrapper around the log adds no padding of its own.
    const controls = classesOf(markup, 'run-output-controls');
    expect(controls).toContain('px-5');
    const body = classesOf(markup, 'run-output-body');
    expect(body.some((name) => /^p[xytrbl]?-/.test(name))).toBe(false);
  });

  it('inks the status label with the operational status role', () => {
    const active = renderModal(['done'], 'active');
    const failed = renderModal(['done'], 'failed');

    expect(active).toContain('fg-info');
    expect(failed).toContain('fg-destructive-strong');
    expect(failed).not.toContain('fg-info');
  });

  it('shows the empty state on the same surface', () => {
    const markup = renderModal([]);

    expect(markup).toContain('No output yet');
    expect(classesOf(markup, 'ansi-output-empty')).toEqual(
      expect.arrayContaining(['bg-secondary', 'px-5', 'py-4', 'flex-1']),
    );
  });
});
