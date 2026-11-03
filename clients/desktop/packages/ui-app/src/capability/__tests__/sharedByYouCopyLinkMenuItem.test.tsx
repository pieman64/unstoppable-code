/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DetailMoreMenuItem } from '@canopy/ui-shared/components/DetailMoreMenu';
import type {
  SharedByYouCopyLinkPort,
  SharedByYouScopedLink,
} from '../../sharing/sharedByYouScopedLink';
import { useSharedByYouCopyLinkMenuItem } from '../sharedByYouCopyLinkMenuItem';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;
let item: DetailMoreMenuItem | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  item = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function linkFor(id: string): SharedByYouScopedLink {
  return {
    url: `canopy://share/skills/${id}?audience=ORGANIZATION`,
    audience: 'organization',
    audienceName: 'Acme',
    personal: false,
    hasPublicLink: false,
  };
}

function Probe({
  link,
  port,
}: {
  link: SharedByYouScopedLink | null;
  port: SharedByYouCopyLinkPort;
}): JSX.Element | null {
  item = useSharedByYouCopyLinkMenuItem(link, port);
  return null;
}

const FIRST = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const SECOND = '0b6f3c2a-8d1e-4f5a-9b7c-6e5d4c3b2a19';

describe('useSharedByYouCopyLinkMenuItem (CAN-5452)', () => {
  it('drops a pending notice when access facts change for the same URL', async () => {
    let finish: (ok: boolean) => void = () => {
      throw new Error('copy not started');
    };
    const port = {
      write: jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      ),
      notify: jest.fn(),
    };
    act(() =>
      root.render(
        <Probe link={{ ...linkFor(FIRST), hasPublicLink: true }} port={port} />,
      ),
    );
    act(() => item?.onSelect());
    act(() => root.render(<Probe link={linkFor(FIRST)} port={port} />));
    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    expect(port.notify).not.toHaveBeenCalled();
  });
  it('adds nothing without a link', () => {
    const port = { write: jest.fn(), notify: jest.fn() };
    act(() => root.render(<Probe link={null} port={port} />));
    expect(item).toBeNull();
  });

  it('posts no notice for a copy that settles after navigating away', async () => {
    let finish: (ok: boolean) => void = () => {
      throw new Error('The write did not start.');
    };
    const write = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const notify = jest.fn();
    const port = { write, notify };
    act(() => root.render(<Probe link={linkFor(FIRST)} port={port} />));
    expect(item).toMatchObject({
      id: 'copy-scoped-link',
      label: 'Copy link',
      testId: 'shared-by-you-copy-link-menu',
    });
    act(() => item?.onSelect());
    expect(write).toHaveBeenCalledWith(linkFor(FIRST).url);

    act(() => root.render(<Probe link={linkFor(SECOND)} port={port} />));
    await act(async () => {
      finish(true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(notify).not.toHaveBeenCalled();
  });
});
