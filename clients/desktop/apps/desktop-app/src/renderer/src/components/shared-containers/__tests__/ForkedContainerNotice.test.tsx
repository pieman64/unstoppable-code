/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ForkedContainerNotice } from '../ForkedContainerNotice';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let readForkProvenance: jest.Mock;

beforeEach(() => {
  readForkProvenance = jest.fn(() =>
    Promise.resolve({
      sourceContainerId: 'container-1',
      sourceRevisionId: 'revision-1',
      sourceOwnerDisplayName: 'Dana',
      organizationId: 'org-1',
      forkedAt: '2026-09-09T10:00:00.000Z',
    }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { sharedContainers: { readForkProvenance } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('surfaces durable provenance for the selected local container', async () => {
  await act(async () => {
    root.render(
      <ForkedContainerNotice projectId="workspace-1" worktreeId="worktree-1" />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(readForkProvenance).toHaveBeenCalledWith({
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
  });
  expect(
    container.querySelector('[data-testid="shared-container-fork-provenance"]')
      ?.textContent,
  ).toContain('Dana');
});

it('renders nothing for an ordinary local container', async () => {
  readForkProvenance.mockResolvedValueOnce(null);

  await act(async () => {
    root.render(
      <ForkedContainerNotice projectId="workspace-1" worktreeId="worktree-1" />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toBe('');
});
