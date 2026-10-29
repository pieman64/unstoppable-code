/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatPartView } from '../ChatPartView';
import {
  ChatMessageAttachments,
  ChatMessageAttachmentInteractionProvider,
  type ChatMessageAttachmentInteraction,
} from '../ChatMessageAttachments';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
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

it('renders remote tool images only through the host asset resolver and releases them', async () => {
  const dispose = jest.fn();
  const resolveImage = jest.fn(() =>
    Promise.resolve({
      src: 'blob:verified-tool-image',
      dispose,
    }),
  );
  await act(() => {
    root.render(
      <ChatMessageAttachmentInteractionProvider
        value={{
          imageSrc: () => null,
          onDownload: () => Promise.resolve(),
          resolveImage,
        }}
      >
        <ChatPartView
          part={{
            kind: 'image',
            data: {
              assetId: 'asset-image',
              mediaType: 'image/png',
              filename: 'tool.png',
            },
          }}
        />
      </ChatMessageAttachmentInteractionProvider>,
    );
    return Promise.resolve();
  });
  expect(resolveImage).toHaveBeenCalledWith(
    expect.objectContaining({ assetId: 'asset-image' }),
    expect.any(AbortSignal),
  );
  expect(container.querySelector('img')?.getAttribute('src')).toBe(
    'blob:verified-tool-image',
  );
  act(() => root.render(<div />));
  expect(dispose).toHaveBeenCalledTimes(1);
});

it('resolves historical attachment thumbnails asynchronously', async () => {
  const resolveImage = jest.fn(() =>
    Promise.resolve({
      src: 'blob:verified-attachment',
    }),
  );
  await act(() => {
    root.render(
      <ChatMessageAttachmentInteractionProvider
        value={{
          imageSrc: () => null,
          onDownload: () => Promise.resolve(),
          resolveImage,
        }}
      >
        <ChatMessageAttachments
          attachments={[
            {
              attachmentId: 'attachment',
              assetId: 'asset-file',
              filename: 'photo.png',
              mediaType: 'image/png',
              sizeBytes: 3,
            },
          ]}
        />
      </ChatMessageAttachmentInteractionProvider>,
    );
    return Promise.resolve();
  });
  expect(container.querySelector('img')?.getAttribute('src')).toBe(
    'blob:verified-attachment',
  );
});

it('never uses URL or path fields from tool image data as a browser source', () => {
  act(() =>
    root.render(
      <ChatPartView
        part={{
          kind: 'image',
          data: {
            url: 'https://private.test/secrets',
            file_path: '/etc/secrets',
            mediaType: 'image/png',
          },
        }}
      />,
    ),
  );
  expect(container.querySelector('img')).toBeNull();
});

it('disposes late results after switching transcript targets', async () => {
  let finish:
    | ((value: { src: string; dispose: () => void }) => void)
    | undefined;
  const dispose = jest.fn();
  const resolveImage = jest.fn(
    () =>
      new Promise<{ src: string; dispose: () => void }>((resolve) => {
        finish = resolve;
      }),
  );
  await act(() => {
    root.render(
      <ChatMessageAttachmentInteractionProvider
        value={{
          imageSrc: () => null,
          onDownload: () => Promise.resolve(),
          resolveImage,
        }}
      >
        <ChatPartView
          part={{
            kind: 'image',
            data: { assetId: 'asset-image', mediaType: 'image/png' },
          }}
        />
      </ChatMessageAttachmentInteractionProvider>,
    );
    return Promise.resolve();
  });
  act(() => root.render(<div />));
  await act(() => {
    finish?.({ src: 'blob:late', dispose });
    return Promise.resolve();
  });
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(container.querySelector('img')).toBeNull();
});

it.each(['handler', 'context'])(
  'keeps a pending download across unrelated interaction changes with %s ownership and disposes completed ownership',
  async (ownership) => {
    const downloadContext = {};
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const signals: AbortSignal[] = [];
    const onDownload = jest.fn(
      (_attachment: unknown, signal?: AbortSignal): Promise<void> => {
        if (signal) signals.push(signal);
        return pending;
      },
    );
    const render = (): void =>
      root.render(
        <ChatMessageAttachmentInteractionProvider
          value={{
            imageSrc: () => null,
            ...(ownership === 'context' ? { downloadContext } : {}),
            onDownload:
              ownership === 'context'
                ? (attachment, signal): Promise<void> =>
                    onDownload(attachment, signal)
                : onDownload,
            onOpen: () => {},
          }}
        >
          <ChatMessageAttachments
            attachments={[
              {
                attachmentId: 'attachment',
                assetId: 'asset-file',
                filename: 'file.txt',
                mediaType: 'text/plain',
              },
            ]}
          />
        </ChatMessageAttachmentInteractionProvider>,
      );
    act(render);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Download file.txt"]')
        ?.click();
      await Promise.resolve();
    });
    act(render);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Downloading file.txt…',
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Download file.txt"]')
        ?.click();
      await Promise.resolve();
    });
    expect(onDownload).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await pending;
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    act(() => root.render(<div />));
    expect(signals[0]?.aborted).toBe(false);
  },
);

it('cancels a replaced semantic context even when its download handler is unchanged', async () => {
  const signals: AbortSignal[] = [];
  const onDownload: ChatMessageAttachmentInteraction['onDownload'] = (
    _attachment,
    signal,
  ) => {
    if (signal) signals.push(signal);
    return new Promise<void>(() => {});
  };
  const render = (downloadContext: object): void =>
    root.render(
      <ChatMessageAttachmentInteractionProvider
        value={{ imageSrc: () => null, onDownload, downloadContext }}
      >
        <ChatMessageAttachments
          attachments={[
            {
              attachmentId: 'attachment',
              assetId: 'asset-file',
              filename: 'file.txt',
              mediaType: 'text/plain',
            },
          ]}
        />
      </ChatMessageAttachmentInteractionProvider>,
    );
  act(() => render({ sessionId: 'session' }));
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Download file.txt"]')
      ?.click();
    await Promise.resolve();
  });
  act(() => render({ sessionId: 'replacement' }));
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBe(true);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

it('aborts replaced download ownership without allowing an old settlement to clear the replacement', async () => {
  let finishOld: () => void = () => {};
  const oldPending = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  const oldSignals: AbortSignal[] = [];
  const newSignals: AbortSignal[] = [];
  const oldDownload: ChatMessageAttachmentInteraction['onDownload'] = (
    _attachment,
    signal,
  ) => {
    if (signal) oldSignals.push(signal);
    return oldPending;
  };
  const newDownload: ChatMessageAttachmentInteraction['onDownload'] = (
    _attachment,
    signal,
  ) => {
    if (signal) newSignals.push(signal);
    return new Promise<void>(() => {});
  };
  const render = (
    onDownload: ChatMessageAttachmentInteraction['onDownload'],
  ): void =>
    root.render(
      <ChatMessageAttachmentInteractionProvider
        value={{ imageSrc: () => null, onDownload }}
      >
        <ChatMessageAttachments
          attachments={[
            {
              attachmentId: 'attachment',
              assetId: 'asset-file',
              filename: 'file.txt',
              mediaType: 'text/plain',
            },
          ]}
        />
      </ChatMessageAttachmentInteractionProvider>,
    );
  act(() => render(oldDownload));
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Download file.txt"]')
      ?.click();
    await Promise.resolve();
  });
  act(() => render(newDownload));
  expect(oldSignals[0]?.aborted).toBe(true);
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[aria-label="Download file.txt"]')
      ?.click();
    await Promise.resolve();
  });
  await act(async () => {
    finishOld();
    await oldPending;
  });
  expect(newSignals[0]?.aborted).toBe(false);
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    'Downloading file.txt…',
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  act(() => root.render(<div />));
  expect(newSignals[0]?.aborted).toBe(true);
});

it('cancels an old download and allows downloading the replacement target', async () => {
  const signals: AbortSignal[] = [];
  const onDownload = jest.fn((_attachment: unknown, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    return new Promise<void>(() => {});
  });
  const interaction = { imageSrc: (): null => null, onDownload };
  const render = (assetId: string): void =>
    root.render(
      <ChatMessageAttachmentInteractionProvider value={interaction}>
        <ChatMessageAttachments
          attachments={[
            {
              attachmentId: 'same-attachment',
              assetId,
              filename: 'file.txt',
              mediaType: 'text/plain',
              sizeBytes: 3,
            },
          ]}
        />
      </ChatMessageAttachmentInteractionProvider>,
    );
  act(() => render('first-asset'));
  await act(() => {
    container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Download file.txt"]',
      )
      ?.click();
    return Promise.resolve();
  });
  expect(onDownload).toHaveBeenCalledTimes(1);
  act(() => render('second-asset'));
  expect(signals[0]?.aborted).toBe(true);
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(() => {
    container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Download file.txt"]',
      )
      ?.click();
    return Promise.resolve();
  });
  expect(onDownload).toHaveBeenCalledTimes(2);
});
