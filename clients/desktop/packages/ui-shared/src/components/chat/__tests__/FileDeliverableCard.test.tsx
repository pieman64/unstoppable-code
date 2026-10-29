/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { FileIcon } from '../../../icons';
import { FileDeliverableCard } from '../FileDeliverableCard';

jest.mock('../../../icons', () => ({
  DownloadIcon: jest.fn(() => <svg />),
  FileIcon: jest.fn(() => <svg />),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

describe('FileDeliverableCard', () => {
  beforeEach(() => jest.clearAllMocks());
  it('opens from a named tile and keeps the download action separate', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const onOpen = jest.fn();
    const onDownload = jest.fn();
    try {
      act(() =>
        root.render(
          <FileDeliverableCard
            filename="report.pdf"
            sizeBytes={1536}
            onOpen={onOpen}
            onDownload={onDownload}
          />,
        ),
      );
      const tile = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Open report.pdf"]',
      );
      expect(tile).not.toBeNull();
      act(() => tile?.click());
      expect(onOpen).toHaveBeenCalledTimes(1);
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Download report.pdf"]',
          )
          ?.click(),
      );
      expect(onDownload).toHaveBeenCalledTimes(1);
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain('1.5 KB');
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not rerender when its inputs are unchanged', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onDownload = (): void => {};
    const onOpen = (): void => {};
    const card = (): JSX.Element => (
      <FileDeliverableCard
        filename="report.pdf"
        sizeBytes={1536}
        onDownload={onDownload}
        onOpen={onOpen}
      />
    );

    try {
      act(() => root.render(card()));
      expect(FileIcon).toHaveBeenCalledTimes(1);
      act(() => root.render(card()));
      expect(FileIcon).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
