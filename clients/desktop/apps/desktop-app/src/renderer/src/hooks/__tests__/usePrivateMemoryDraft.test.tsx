/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  usePrivateMemoryDraft,
  type PrivateMemoryDraft,
  type PrivateMemoryProjection,
} from '@/hooks/usePrivateMemoryDraft';
import { saveWorkspacePrivateMemory } from '@/lib/privateMemory';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/lib/privateMemory', () => ({
  saveWorkspacePrivateMemory: jest.fn(),
}));
const savePrivateMemory = jest.mocked(saveWorkspacePrivateMemory);

interface OwnedRow {
  id: string;
  owner?: { organizationId: string };
}
const mockProjectsState: { projects: OwnedRow[] } = { projects: [] };

jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: <T,>(selector: (state: typeof mockProjectsState) => T): T =>
    selector(mockProjectsState),
}));

describe('usePrivateMemoryDraft', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: PrivateMemoryDraft;

  function Probe({
    project,
  }: {
    project: PrivateMemoryProjection | null;
  }): JSX.Element {
    latest = usePrivateMemoryDraft(project);
    return <span />;
  }

  function render(project: PrivateMemoryProjection | null): void {
    act(() => {
      root.render(<Probe project={project} />);
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockProjectsState.projects = [];
    savePrivateMemory.mockReset().mockResolvedValue(undefined);
    useWorkspaceContextStore.setState({
      state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it.each([
    [undefined, false],
    [false, false],
    [true, true],
  ])(
    'seeds from the projected value (%s) and starts clean',
    (privateMemory, checked) => {
      render({ id: 'alpha', privateMemory });

      expect(latest.checked).toBe(checked);
      expect(latest.dirty).toBe(false);
      expect(latest.managed).toBe(false);
      expect(latest.error).toBeNull();
    },
  );

  it('tracks a change in both directions', () => {
    render({ id: 'alpha' });
    act(() => latest.setChecked(true));
    expect(latest.checked).toBe(true);
    expect(latest.dirty).toBe(true);

    act(() => latest.setChecked(false));
    expect(latest.checked).toBe(false);
    expect(latest.dirty).toBe(false);

    render({ id: 'alpha', privateMemory: true });
    expect(latest.dirty).toBe(true);
  });

  it('saves a changed draft and does nothing for a clean one', async () => {
    render({ id: 'alpha' });
    await act(async () => {
      await expect(latest.save()).resolves.toBe(true);
    });
    expect(savePrivateMemory).not.toHaveBeenCalled();

    act(() => latest.setChecked(true));
    await act(async () => {
      await expect(latest.save()).resolves.toBe(true);
    });
    expect(savePrivateMemory).toHaveBeenCalledWith('alpha', true);

    // The reloaded row carries the saved value, so the draft is clean again.
    render({ id: 'alpha', privateMemory: true });
    expect(latest.checked).toBe(true);
    expect(latest.dirty).toBe(false);
  });

  it('keeps a change made while the save was in flight', async () => {
    render({ id: 'alpha' });
    let finish: () => void = () => undefined;
    savePrivateMemory.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    act(() => latest.setChecked(true));
    let saving: Promise<boolean> = Promise.resolve(true);
    act(() => {
      saving = latest.save();
    });
    // Changed back before the first save lands.
    act(() => latest.setChecked(false));
    await act(async () => {
      finish();
      await saving;
    });
    expect(savePrivateMemory).toHaveBeenCalledWith('alpha', true);

    // The reloaded row says true; the later choice is still the draft.
    render({ id: 'alpha', privateMemory: true });
    expect(latest.checked).toBe(false);
    expect(latest.dirty).toBe(true);
  });

  it('shows the inherited value, locked, and names the organization', () => {
    mockProjectsState.projects = [
      { id: 'alpha', owner: { organizationId: 'org-a' } },
    ];
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'personal' },
        revision: 1,
        organizations: [{ id: 'org-a', name: 'Acme', role: 'MEMBER' }],
      },
    });
    render({
      id: 'alpha',
      privateMemory: true,
      privateMemoryManagedBy: 'organization',
    });

    expect(latest.managed).toBe(true);
    expect(latest.checked).toBe(true);
    expect(latest.organizationName).toBe('Acme');

    // A stale draft cannot override or save over a managed value.
    act(() => latest.setChecked(false));
    expect(latest.checked).toBe(true);
    expect(latest.dirty).toBe(false);
  });

  it('applies an explicit managed false and leaves the name unknown when it is', async () => {
    render({ id: 'alpha' });
    act(() => latest.setChecked(true));
    render({
      id: 'alpha',
      privateMemory: false,
      privateMemoryManagedBy: 'organization',
    });

    expect(latest.checked).toBe(false);
    expect(latest.dirty).toBe(false);
    expect(latest.organizationName).toBeUndefined();
    await act(async () => {
      await expect(latest.save()).resolves.toBe(true);
    });
    expect(savePrivateMemory).not.toHaveBeenCalled();
  });

  it('surfaces a refusal and falls back to the reloaded value', async () => {
    savePrivateMemory.mockRejectedValue(
      new Error('Private memory is managed by your organization'),
    );
    render({ id: 'alpha' });
    act(() => latest.setChecked(true));

    await act(async () => {
      await expect(latest.save()).resolves.toBe(false);
    });
    expect(latest.error).toBe('Private memory is managed by your organization');

    // The refusal reloaded the rows: the value is now the organization's.
    render({
      id: 'alpha',
      privateMemory: false,
      privateMemoryManagedBy: 'organization',
    });
    expect(latest.checked).toBe(false);
    expect(latest.managed).toBe(true);
    expect(latest.error).toBe('Private memory is managed by your organization');

    act(() => latest.reset());
    expect(latest.error).toBeNull();
  });

  it('clears the error on the next change', async () => {
    savePrivateMemory.mockRejectedValueOnce(new Error('disk full'));
    render({ id: 'alpha' });
    act(() => latest.setChecked(true));
    await act(async () => {
      await latest.save();
    });
    expect(latest.error).toBe('disk full');
    expect(latest.checked).toBe(false);

    act(() => latest.setChecked(true));
    expect(latest.error).toBeNull();
  });

  it('never carries a draft or an error over to another project', async () => {
    savePrivateMemory.mockRejectedValueOnce(new Error('disk full'));
    render({ id: 'alpha' });
    act(() => latest.setChecked(true));
    await act(async () => {
      await latest.save();
    });
    act(() => latest.setChecked(true));

    render({ id: 'beta' });
    expect(latest.checked).toBe(false);
    expect(latest.dirty).toBe(false);
    expect(latest.error).toBeNull();
    await act(async () => {
      await latest.save();
    });
    expect(savePrivateMemory).toHaveBeenCalledTimes(1);
    expect(savePrivateMemory).not.toHaveBeenCalledWith('beta', true);
  });

  it('is inert without a project', async () => {
    render(null);
    expect(latest.checked).toBe(false);
    await act(async () => {
      await expect(latest.save()).resolves.toBe(true);
    });
    expect(savePrivateMemory).not.toHaveBeenCalled();
  });
});
