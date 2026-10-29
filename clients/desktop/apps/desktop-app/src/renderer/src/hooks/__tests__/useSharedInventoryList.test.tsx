/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SharedCollectionSummary } from '@canopy/desktop-shared/types/collections';
import type { SharedSkillSummary } from '@canopy/desktop-shared/types/skills';
import {
  useSharedCollectionList,
  type UseSharedCollectionListReturn,
} from '../useSharedCollectionList';
import {
  useSharedSkillList,
  type UseSharedSkillListReturn,
} from '../useSharedSkillList';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const cloudAccount = {
  hasApiKey: true,
  account: { id: 'account-1' },
  updatedAt: '2026-09-03T00:00:00.000Z',
  capabilities: ['skills-crud-v1', 'collections-crud-v1'],
};

const initialSkill: SharedSkillSummary = {
  id: 'shared-skill',
  name: 'Shared Skill',
  description: 'A shared skill.',
  contentHash: 'before-skill-hash',
  shareScope: 'organization',
  owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
  createdBy: { id: 'author', name: 'Author', email: null },
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  canUpdate: false,
  canDelete: false,
  publicShare: null,
};
const updatedSkill = {
  ...initialSkill,
  contentHash: 'after-skill-hash',
};
const initialCollection: SharedCollectionSummary = {
  id: 'shared-collection',
  name: 'Shared Collection',
  description: 'A shared collection.',
  contentHash: 'before-collection-hash',
  itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
  shareScope: 'organization',
  owner: { type: 'organization', id: 'canopy', name: 'Canopy' },
  createdBy: { id: 'author', name: 'Author', email: null },
  createdAt: '2026-08-28T00:00:00.000Z',
  updatedAt: '2026-08-28T00:00:00.000Z',
  canUpdate: false,
  canDelete: false,
};
const updatedCollection = {
  ...initialCollection,
  contentHash: 'after-collection-hash',
};

describe('shared inventory list refreshes', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue(cloudAccount),
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
    Reflect.deleteProperty(window, 'skills');
    Reflect.deleteProperty(window, 'collections');
  });

  it('keeps a shared skill resolvable while an update-triggered refresh is in flight', async () => {
    const replacement = deferred<{
      skills: SharedSkillSummary[];
      nextCursor: null;
    }>();
    const listShared = jest
      .fn()
      .mockResolvedValueOnce({ skills: [initialSkill], nextCursor: null })
      .mockReturnValueOnce(replacement.promise);
    Object.defineProperty(window, 'skills', {
      configurable: true,
      value: { listShared },
    });
    let current: UseSharedSkillListReturn | null = null;

    function Probe(): null {
      const value = useSharedSkillList();
      useEffect(() => {
        current = value;
      });
      return null;
    }

    function getCurrent(): UseSharedSkillListReturn {
      if (current === null) throw new Error('Shared skill probe did not mount');
      return current;
    }

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    await act(async () => {
      await current?.refreshShared();
    });

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = getCurrent().refreshShared();
    });
    expect(
      getCurrent().skills.find(({ id }) => id === initialSkill.id),
    ).toEqual(initialSkill);

    replacement.resolve({ skills: [updatedSkill], nextCursor: null });
    await act(async () => refreshPromise);
    expect(current?.skills).toEqual([updatedSkill]);
  });

  it('keeps a shared collection resolvable while an update-triggered refresh is in flight', async () => {
    const replacement = deferred<{
      collections: SharedCollectionSummary[];
      nextCursor: null;
    }>();
    const listShared = jest
      .fn()
      .mockResolvedValueOnce({
        collections: [initialCollection],
        nextCursor: null,
      })
      .mockReturnValueOnce(replacement.promise);
    Object.defineProperty(window, 'collections', {
      configurable: true,
      value: { listShared },
    });
    let current: UseSharedCollectionListReturn | null = null;

    function Probe(): null {
      const value = useSharedCollectionList();
      useEffect(() => {
        current = value;
      });
      return null;
    }

    function getCurrent(): UseSharedCollectionListReturn {
      if (current === null) {
        throw new Error('Shared collection probe did not mount');
      }
      return current;
    }

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    await act(async () => {
      await current?.refreshShared();
    });

    let refreshPromise!: Promise<void>;
    act(() => {
      refreshPromise = getCurrent().refreshShared();
    });
    expect(
      getCurrent().collections.find(({ id }) => id === initialCollection.id),
    ).toEqual(initialCollection);

    replacement.resolve({ collections: [updatedCollection], nextCursor: null });
    await act(async () => refreshPromise);
    expect(current?.collections).toEqual([updatedCollection]);
  });
});
