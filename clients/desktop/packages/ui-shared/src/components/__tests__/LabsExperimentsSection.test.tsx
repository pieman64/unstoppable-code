/** @jest-environment jsdom */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
  LabsExperimentsSection,
  type LabsExperimentRowView,
  type LabsExperimentsSectionLayout,
} from '../LabsExperimentsSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const LAYOUT: LabsExperimentsSectionLayout = {
  Section: ({
    title,
    description,
    dataTestId,
    children,
  }: {
    title?: ReactNode;
    description?: ReactNode;
    dataTestId?: string;
    children?: ReactNode;
  }): JSX.Element => (
    <section data-testid={dataTestId}>
      <h2>{title}</h2>
      {description !== undefined && <p>{description}</p>}
      {children}
    </section>
  ),
  Group: ({ children }: { children?: ReactNode }): JSX.Element => (
    <div>{children}</div>
  ),
  Row: ({
    label,
    control,
    dataTestId,
  }: {
    label: ReactNode;
    control?: ReactNode;
    dataTestId?: string;
  }): JSX.Element => (
    <div data-testid={dataTestId}>
      <span>{label}</span>
      {control}
    </div>
  ),
};

const ROWS: LabsExperimentRowView[] = [
  {
    id: 'early-access',
    name: 'Early access',
    description: 'Unfinished features.',
    checked: true,
    disabled: false,
  },
  {
    id: 'audit',
    name: 'Audit log',
    description: 'Review activity.',
    checked: false,
    disabled: true,
  },
];

function render(
  rows: readonly LabsExperimentRowView[],
  onToggle: (id: string, enabled: boolean) => void = () => undefined,
  error: string | null = null,
): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <LabsExperimentsSection
        rows={rows}
        error={error}
        onToggle={onToggle}
        layout={LAYOUT}
      />,
    );
  });
  return {
    container,
    unmount: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function toggle(container: HTMLElement, testId: string): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
  if (!element) throw new Error(`Expected ${testId}.`);
  return element;
}

describe('LabsExperimentsSection', () => {
  it('renders nothing without listed experiments', () => {
    const { container, unmount } = render([]);
    expect(container.innerHTML).toBe('');
    unmount();
  });

  it('keeps the Early access ids and names each switch', () => {
    const { container, unmount } = render(ROWS);
    expect(
      container.querySelector('[data-testid="settings-experimental-features"]')
        ?.textContent,
    ).toContain('Try new features early');
    const early = toggle(container, 'experimental-features-toggle');
    expect(early.id).toBe('settings-experimental-features-toggle');
    expect(early.getAttribute('aria-label')).toBe('Early access');
    expect(early.getAttribute('aria-checked')).toBe('true');
    const audit = toggle(container, 'labs-experiment-toggle-audit');
    expect(audit.getAttribute('aria-label')).toBe('Audit log');
    expect(audit.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="labs-experiment-row-audit"]'),
    ).not.toBeNull();
    unmount();
  });

  it('reports the requested value and shows a save error', () => {
    const onToggle = jest.fn();
    const { container, unmount } = render(
      ROWS,
      onToggle,
      'Could not save this setting. Try again.',
    );
    act(() => toggle(container, 'experimental-features-toggle').click());
    expect(onToggle).toHaveBeenCalledWith('early-access', false);
    expect(container.textContent).toContain('Could not save this setting.');
    unmount();
  });

  const PAGE_ROW: LabsExperimentRowView = {
    id: 'kanban-page',
    name: 'Kanban',
    description: 'A board of your worktrees.',
    checked: false,
    disabled: false,
    group: 'pages',
  };

  function section(container: HTMLElement, testId: string): Element | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  it('lists page experiments in their own Experiments section', () => {
    const { container, unmount } = render([...ROWS, PAGE_ROW]);
    const early = section(container, 'settings-experimental-features');
    const pages = section(container, 'settings-labs-pages');
    expect(pages?.textContent).toContain('Experiments');
    expect(pages?.textContent).toContain('Turn on the ones you want to try.');
    expect(
      pages?.querySelector('[data-testid="labs-experiment-row-kanban-page"]'),
    ).not.toBeNull();
    expect(
      early?.querySelector('[data-testid="labs-experiment-row-kanban-page"]'),
    ).toBeNull();
    expect(
      early?.querySelector('[data-testid="labs-experiment-row-audit"]'),
    ).not.toBeNull();
    unmount();
  });

  it('renders only the section that has rows', () => {
    const pagesOnly = render([PAGE_ROW], () => undefined, 'Could not save.');
    expect(
      section(pagesOnly.container, 'settings-experimental-features'),
    ).toBeNull();
    expect(section(pagesOnly.container, 'settings-labs-pages')).not.toBeNull();
    // The save error still shows when only the Pages section renders.
    expect(pagesOnly.container.textContent).toContain('Could not save.');
    pagesOnly.unmount();

    const earlyOnly = render(ROWS);
    expect(section(earlyOnly.container, 'settings-labs-pages')).toBeNull();
    expect(
      section(earlyOnly.container, 'settings-experimental-features'),
    ).not.toBeNull();
    earlyOnly.unmount();
  });
});
