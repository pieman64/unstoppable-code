/**
 * @jest-environment jsdom
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PendingProjectRow,
  PendingProjectRows,
  type SidebarPendingProject,
} from '../PendingProjectRow';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const base: SidebarPendingProject = {
  id: 'job-1',
  name: 'website',
  status: 'cloning',
};

describe('PendingProjectRow', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(element: ReactElement): void {
    act(() => root.render(element));
  }
  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }
  function button(name: string): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      `button[aria-label="${name}"]`,
    );
  }
  function click(element: HTMLElement | null): void {
    act(() => element?.click());
  }

  it('shows the repository name, default cloning status, and a spinner', () => {
    render(<PendingProjectRow project={base} />);
    expect(byTestId('sidebar-pending-project-job-1')).not.toBeNull();
    expect(container.textContent).toContain('website');
    const status = byTestId('sidebar-pending-project-status-job-1');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toBe('Cloning…');
    expect(byTestId('sidebar-pending-project-spinner-job-1')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('uses the default cancelling status and keeps the spinner', () => {
    render(<PendingProjectRow project={{ ...base, status: 'cancelling' }} />);
    expect(byTestId('sidebar-pending-project-status-job-1')?.textContent).toBe(
      'Cancelling…',
    );
    expect(byTestId('sidebar-pending-project-spinner-job-1')).not.toBeNull();
  });

  it('prefers host status text while active', () => {
    render(
      <PendingProjectRow
        project={{ ...base, statusText: 'Waiting for the desktop…' }}
      />,
    );
    expect(byTestId('sidebar-pending-project-status-job-1')?.textContent).toBe(
      'Waiting for the desktop…',
    );
  });

  it('hides the spinner when the host says the row is not active', () => {
    render(
      <PendingProjectRow
        project={{ ...base, statusText: 'Unconfirmed', active: false }}
      />,
    );
    expect(byTestId('sidebar-pending-project-spinner-job-1')).toBeNull();
  });

  it('shows a failure with its message and no spinner', () => {
    render(
      <PendingProjectRow
        project={{
          ...base,
          status: 'failed',
          message: 'Failed to clone the repository.',
        }}
      />,
    );
    const status = byTestId('sidebar-pending-project-status-job-1');
    // The row's title already names the project.
    expect(status?.textContent).toBe('Failed to clone the repository.');
    expect(byTestId('sidebar-pending-project-spinner-job-1')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders Retry and Dismiss only when callbacks exist', () => {
    const onRetry = jest.fn();
    const onDismiss = jest.fn();
    render(
      <PendingProjectRow
        project={{ ...base, status: 'failed', onRetry, onDismiss }}
      />,
    );
    const retry = button('Retry website');
    const dismiss = button('Dismiss website');
    expect(retry?.getAttribute('data-testid')).toBe(
      'sidebar-pending-project-retry-job-1',
    );
    expect(dismiss?.getAttribute('data-testid')).toBe(
      'sidebar-pending-project-dismiss-job-1',
    );
    expect(retry?.type).toBe('button');
    click(retry);
    click(dismiss);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('disables Retry while the host is retrying', () => {
    const onRetry = jest.fn();
    render(
      <PendingProjectRow
        project={{ ...base, status: 'failed', onRetry, retrying: true }}
      />,
    );
    const retry = button('Retry website');
    expect(retry?.disabled).toBe(true);
    click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('does not offer Retry on an active row', () => {
    render(<PendingProjectRow project={{ ...base, onRetry: jest.fn() }} />);
    expect(button('Retry website')).toBeNull();
  });

  it('offers Dismiss on an active row when the host allows it', () => {
    const onDismiss = jest.fn();
    render(<PendingProjectRow project={{ ...base, onDismiss }} />);
    click(button('Dismiss website'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders markup in names and messages as text', () => {
    render(
      <PendingProjectRow
        project={{
          id: 'x',
          name: '<img src=x onerror=alert(1)>',
          status: 'failed',
          message: '<b>bold</b>',
        }}
      />,
    );
    const row = byTestId('sidebar-pending-project-x');
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.querySelector('b')).toBeNull();
    expect(row?.textContent).toContain('<b>bold</b>');
  });

  it('truncates long names and wraps long messages', () => {
    const name = 'n'.repeat(300);
    render(
      <PendingProjectRow
        project={{
          id: 'long',
          name,
          status: 'failed',
          message: 'm'.repeat(600),
        }}
      />,
    );
    expect(container.querySelector(`[title="${name}"]`)?.className).toContain(
      'truncate',
    );
    expect(
      byTestId('sidebar-pending-project-status-long')?.className,
    ).toContain('break-words');
  });

  it('renders nothing for an empty list', () => {
    render(<PendingProjectRows projects={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one row per project in order', () => {
    render(
      <PendingProjectRows
        projects={[base, { id: 'job-2', name: 'api', status: 'failed' }]}
      />,
    );
    const rows = Array.from(
      container.querySelectorAll('[data-pending-project-row]'),
    );
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
      'sidebar-pending-project-job-1',
      'sidebar-pending-project-job-2',
    ]);
  });
});
