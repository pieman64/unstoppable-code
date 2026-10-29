/** @jest-environment jsdom */
import { act, createElement } from 'react';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { createRoot, type Root } from 'react-dom/client';
import type { SharedAutomationPublicShareInfo } from '@canopy/protocol/automations';
import { automationSharePath } from '@canopy/protocol/automations';

const mockCopy = jest.fn<Promise<boolean>, [string]>();
jest.mock('@/lib/clipboard', () => ({
  copyTextToClipboard: (text: string): Promise<boolean> => mockCopy(text),
}));
import { AutomationPublicShareRow } from '../AutomationPublicShareRow';

const mockBaseUrl = jest.fn<Promise<string | null>, []>();
const mockPublish = jest.fn<
  Promise<SharedAutomationPublicShareInfo>,
  [string]
>();
const mockRevoke = jest.fn<Promise<void>, [string]>();

const REMOTE_ID = '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111';
const publicShare: SharedAutomationPublicShareInfo = {
  externalId: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
  pinnedContentHash: 'public-hash',
  upToDate: true,
  sharePath: automationSharePath('9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'),
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

let root: Root | null = null;

beforeEach((): void => {
  jest.clearAllMocks();
  mockBaseUrl.mockResolvedValue('https://cloud.test');
  mockPublish.mockResolvedValue(publicShare);
  mockRevoke.mockResolvedValue(undefined);
  mockCopy.mockResolvedValue(true);
  Object.assign(window, {
    api: {
      getCanopyCloudBaseUrl: mockBaseUrl,
      automations: {
        publishPublicShare: mockPublish,
        revokePublicShare: mockRevoke,
      },
    },
  });
});

afterEach((): void => {
  act((): void => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function byTestId(id: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!(element instanceof HTMLElement))
    throw new Error(`Missing testid ${id}`);
  return element;
}

function query(id: string): Element | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

async function click(id: string): Promise<void> {
  await act(async (): Promise<void> => {
    byTestId(id).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderRow(
  props: {
    initialShare?: SharedAutomationPublicShareInfo | null;
    canManage?: boolean;
  } = {},
): Promise<void> {
  root = createRoot(document.body);
  await act(async (): Promise<void> => {
    root?.render(
      createElement(AutomationPublicShareRow, {
        remoteId: REMOTE_ID,
        ...props,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

it('publishes, copies, revokes, and republishes an existing share', async (): Promise<void> => {
  await renderRow();
  expect(byTestId('automation-public-share-row')).toBeDefined();
  expect(byTestId('automation-public-share-publish').textContent).toBe(
    'Publish',
  );
  await click('automation-public-share-publish');
  expect(mockPublish).toHaveBeenCalledWith(REMOTE_ID);
  expect(byTestId('automation-public-share-row').textContent).toContain(
    `https://cloud.test${publicShare.sharePath}`,
  );
  await click('automation-public-share-copy');
  expect(mockCopy).toHaveBeenCalledWith(
    `https://cloud.test${publicShare.sharePath}`,
  );
  expect(byTestId('automation-public-share-copy').textContent).toBe('Copied');
  await click('automation-public-share-revoke');
  expect(mockRevoke).toHaveBeenCalledWith(REMOTE_ID);
  expect(byTestId('automation-public-share-row').textContent).not.toContain(
    publicShare.sharePath,
  );
  await click('automation-public-share-publish');
  expect(mockPublish).toHaveBeenCalledTimes(2);
});

it('loads the existing public snapshot and offers an update when stale', async (): Promise<void> => {
  await renderRow({ initialShare: { ...publicShare, upToDate: false } });
  expect(byTestId('automation-public-share-row').textContent).toContain(
    publicShare.sharePath,
  );
  expect(byTestId('automation-public-share-update').textContent).toBe(
    'Update to latest',
  );
});

it('keeps a published link visible when revocation fails', async (): Promise<void> => {
  mockRevoke.mockRejectedValueOnce(new Error('Unable to revoke'));
  await renderRow({ initialShare: publicShare });
  await click('automation-public-share-revoke');
  expect(byTestId('automation-public-share-error').textContent).toContain(
    'Unable to revoke',
  );
  expect(byTestId('automation-public-share-error').getAttribute('role')).toBe(
    'alert',
  );
  expect(byTestId('automation-public-share-row').textContent).toContain(
    publicShare.sharePath,
  );
  expect(
    byTestId('automation-public-share-revoke').hasAttribute('disabled'),
  ).toBe(false);
});

it('reports a failed publish and allows retry', async (): Promise<void> => {
  mockPublish.mockRejectedValueOnce(new Error('Unable to publish'));
  await renderRow();
  await click('automation-public-share-publish');
  expect(byTestId('automation-public-share-error').textContent).toContain(
    'Unable to publish',
  );
  expect(
    byTestId('automation-public-share-publish').hasAttribute('disabled'),
  ).toBe(false);
  await click('automation-public-share-publish');
  expect(byTestId('automation-public-share-row').textContent).toContain(
    publicShare.sharePath,
  );
});

it('falls back to the share path when the cloud URL cannot be resolved', async (): Promise<void> => {
  mockBaseUrl.mockResolvedValue(null);
  await renderRow({ initialShare: publicShare });
  expect(byTestId('automation-public-share-row').textContent).toContain(
    publicShare.sharePath,
  );
  await click('automation-public-share-revoke');
  expect(mockRevoke).toHaveBeenCalledTimes(1);
});

it('renders nothing for a read-only member with no public link', async (): Promise<void> => {
  await renderRow({ canManage: false });
  expect(query('automation-public-share-row')).toBeNull();
});

it('offers copy but no mutation for a read-only member with a link', async (): Promise<void> => {
  await renderRow({ initialShare: publicShare, canManage: false });
  expect(byTestId('automation-public-share-copy')).toBeDefined();
  expect(query('automation-public-share-publish')).toBeNull();
  expect(query('automation-public-share-revoke')).toBeNull();
  expect(mockPublish).not.toHaveBeenCalled();
  expect(mockRevoke).not.toHaveBeenCalled();
});

it('dispatches the public-share-changed event on publish and revoke', async (): Promise<void> => {
  const seen: string[] = [];
  const listener = (): void => {
    seen.push('changed');
  };
  window.addEventListener('canopy:automation-public-share-changed', listener);
  await renderRow();
  await click('automation-public-share-publish');
  await click('automation-public-share-revoke');
  window.removeEventListener(
    'canopy:automation-public-share-changed',
    listener,
  );
  expect(seen).toHaveLength(2);
});
