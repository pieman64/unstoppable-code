/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { FileAttachmentChip } from '../FileAttachmentChip';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

it('renders a compact filename chip without card metadata', () => {
  const out = renderToString(
    <FileAttachmentChip filename="transactions.csv" />,
  );

  expect(out).toContain('data-testid="file-attachment-chip"');
  expect(out).toContain('transactions.csv');
  expect(out).toContain('inline-flex');
  expect(out).not.toContain('Download');
  expect(out).not.toContain('Open');
  expect(out).not.toContain('512 B');
});

it('uses host-provided icon, open, download, and hover behavior', () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onOpen = jest.fn();
  const onDownload = jest.fn();
  const onMouseEnter = jest.fn();
  const onMouseLeave = jest.fn();

  act(() =>
    root.render(
      <FileAttachmentChip
        filename="transactions.csv"
        icon={<span data-testid="custom-file-icon">CSV</span>}
        onOpen={onOpen}
        onDownload={onDownload}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      />,
    ),
  );

  expect(
    container.querySelector('[data-testid="custom-file-icon"]'),
  ).not.toBeNull();
  const chip = container.querySelector<HTMLElement>(
    '[data-testid="file-attachment-chip"]',
  );
  const open = container.querySelector<HTMLButtonElement>(
    '[aria-label="Open transactions.csv"]',
  );
  const download = container.querySelector<HTMLButtonElement>(
    '[aria-label="Download transactions.csv"]',
  );
  expect(chip).not.toBeNull();
  expect(open).not.toBeNull();
  expect(download).not.toBeNull();

  act(() => {
    open?.click();
    download?.click();
    chip?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    chip?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });

  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onDownload).toHaveBeenCalledTimes(1);
  expect(onMouseEnter).toHaveBeenCalledTimes(1);
  expect(onMouseLeave).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  container.remove();
});
