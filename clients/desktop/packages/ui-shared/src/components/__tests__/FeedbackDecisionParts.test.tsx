/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CopyDetailsButton } from '../CopyDetailsButton';
import { StatusLabel } from '../StatusLabel';
import { EmptyStateRow, ErrorBanner } from '../StatusBlocks';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(element: JSX.Element): void {
  act(() => root.render(element));
}

describe('EmptyStateRow', () => {
  it('is one quiet line at row height, with no frame and no heading', () => {
    render(<EmptyStateRow title="No teams yet" testId="teams-empty" />);
    const row = container.querySelector('[data-testid="teams-empty"]');
    expect(row?.textContent).toBe('No teams yet');
    expect(row?.className).toContain('min-h-10');
    expect(row?.className).toContain('fg-tertiary');
    expect(row?.className).not.toMatch(/\b(border|rounded|bg-|text-center)/);
    expect(container.querySelector('h3')).toBeNull();
  });
});

describe('StatusLabel', () => {
  it('keeps the row status in red text by default at the row size', () => {
    render(<StatusLabel data-testid="status">Expired</StatusLabel>);
    const label = container.querySelector('[data-testid="status"]');
    expect(label?.tagName).toBe('SPAN');
    expect(label?.textContent).toBe('Expired');
    expect(label?.className.split(' ')).toContain('fg-destructive');
    expect(label?.className).not.toMatch(/\btext-/);
  });

  it('maps the warning and success tones and an explicit size', () => {
    render(
      <>
        <StatusLabel tone="attention" size="xs" data-testid="a">
          Needs sign-in
        </StatusLabel>
        <StatusLabel tone="positive" data-testid="p">
          Connected
        </StatusLabel>
      </>,
    );
    const attention = container.querySelector('[data-testid="a"]');
    expect(attention?.className.split(' ')).toEqual(
      expect.arrayContaining(['fg-warning', 'text-xs']),
    );
    expect(
      container.querySelector('[data-testid="p"]')?.className.split(' '),
    ).toContain('fg-success');
  });
});

describe('CopyDetailsButton', () => {
  it('copies the details without rendering them', async () => {
    const write = jest.fn((): Promise<boolean> => Promise.resolve(true));
    render(
      <CopyDetailsButton
        details="HTTP 502 from upstream: token abc"
        write={write}
      />,
    );
    expect(container.textContent).not.toContain('HTTP 502');
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Copy details');
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledWith('HTTP 502 from upstream: token abc');
    expect(container.querySelector('button')?.textContent).toBe('Copied');
    expect(container.textContent).not.toContain('HTTP 502');
  });
});

describe('ErrorBanner details', () => {
  it('offers Copy details beside our sentence and never shows the raw text', () => {
    render(
      <ErrorBanner
        error="Couldn't connect. Check the server URL, then test again."
        details="ECONNREFUSED 127.0.0.1:9000"
      />,
    );
    expect(container.textContent).toContain("Couldn't connect.");
    expect(container.textContent).toContain('Copy details');
    expect(container.textContent).not.toContain('ECONNREFUSED');
  });

  it('shows no copy action without details', () => {
    render(<ErrorBanner error="Couldn't connect." />);
    expect(container.querySelector('button')).toBeNull();
  });
});
