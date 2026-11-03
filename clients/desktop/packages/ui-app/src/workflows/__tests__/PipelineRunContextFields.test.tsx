/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PIPELINE_RUN_CONTEXT_COPY,
  PipelineRunContextFields,
  type PipelineRunContextFieldsProps,
} from '../PipelineRunContextFields';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

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

function render(props: PipelineRunContextFieldsProps): void {
  act(() => {
    root.render(<PipelineRunContextFields {...props} />);
  });
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('PipelineRunContextFields', () => {
  it('renders nothing without a location or owner to show', () => {
    render({});
    expect(container.innerHTML).toBe('');
  });

  it('offers No project and Current task, explaining an unavailable task', () => {
    const onChange = jest.fn();
    render({
      location: { value: 'global', onChange, currentTaskUnavailable: true },
    });
    expect(byTestId('pipeline-run-location-global')?.textContent).toContain(
      'No project',
    );
    expect(container.textContent).toContain(
      PIPELINE_RUN_CONTEXT_COPY.currentTaskUnavailable,
    );
  });

  it('shows a saved owner as plain text with the Runs helper', () => {
    render({ owner: { kind: 'fixed', label: 'Acme' } });
    const fixed = byTestId('pipeline-run-owner-fixed');
    expect(fixed?.textContent).toBe('Acme');
    // A generic paragraph can't take a name; a group announces Owner.
    expect(fixed?.getAttribute('role')).toBe('group');
    expect(
      document.getElementById(fixed?.getAttribute('aria-labelledby') ?? '')
        ?.textContent,
    ).toBe('Owner');
    expect(byTestId('pipeline-run-owner-select')).toBeNull();
    expect(container.textContent).toContain(
      PIPELINE_RUN_CONTEXT_COPY.ownerHelper,
    );
  });

  it('shows loading, and a failure with Try again', () => {
    render({ owner: { kind: 'loading' } });
    expect(byTestId('pipeline-run-owner-loading')?.textContent).toBe(
      PIPELINE_RUN_CONTEXT_COPY.ownersLoading,
    );

    const onRetry = jest.fn();
    render({ owner: { kind: 'error', onRetry } });
    const retry = byTestId('pipeline-run-owner-error')?.querySelector('button');
    expect(retry?.textContent).toBe('Try again');
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('asks for an owner and says when the earlier one is gone', () => {
    render({
      owner: {
        kind: 'choose',
        options: [{ value: 'personal', label: 'Personal' }],
        value: null,
        onChange: jest.fn(),
        stale: true,
      },
    });
    expect(byTestId('pipeline-run-owner-select')?.textContent).toBe(
      PIPELINE_RUN_CONTEXT_COPY.ownerPlaceholder,
    );
    expect(byTestId('pipeline-run-owner-stale')?.textContent).toBe(
      PIPELINE_RUN_CONTEXT_COPY.ownerStale,
    );
  });
});
