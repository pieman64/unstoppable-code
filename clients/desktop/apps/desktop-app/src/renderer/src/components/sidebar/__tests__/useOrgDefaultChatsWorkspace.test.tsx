/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { orgDefaultCoworkWorkspaceId } from '@canopy/protocol/ui-labels';
import type { WorkspaceContextState } from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  useOrgDefaultChatsWorkspace,
  type OrgDefaultChatsWorkspaceState,
} from '../useOrgDefaultChatsWorkspace';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORG = '33333333-3333-4333-8333-333333333333';

const ORG_STATE: WorkspaceContextState = {
  context: { kind: 'organization', organizationId: ORG },
  revision: 1,
  organizations: [{ id: ORG, name: 'Acme', role: 'MEMBER' }],
};

type Eligibility = 'eligible' | 'ineligible';

function Harness({
  probe,
}: {
  probe: { current: OrgDefaultChatsWorkspaceState | null };
}): JSX.Element {
  const context = useWorkspaceContextStore((store) => store.state.context);
  probe.current = useOrgDefaultChatsWorkspace(context);
  return <div />;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  });
}

describe('useOrgDefaultChatsWorkspace', () => {
  const originalApi = Object.getOwnPropertyDescriptor(window, 'api');
  const originalContext = useWorkspaceContextStore.getState();
  const originalProjects = useProjectsStore.getState();
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useWorkspaceContextStore.setState({ state: ORG_STATE, hydrated: true });
    useProjectsStore.setState({ projects: [] });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useWorkspaceContextStore.setState(originalContext, true);
    useProjectsStore.setState(originalProjects, true);
    if (originalApi) {
      Object.defineProperty(window, 'api', originalApi);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('shows organization Chats once main reports the organization eligible again', async () => {
    let eligibility: Eligibility = 'ineligible';
    const getOrgDefaultCoworkEligibility = jest.fn(
      (): Promise<Eligibility> => Promise.resolve(eligibility),
    );
    const ensureOrgDefaultCoworkWorkspace = jest.fn(
      (): Promise<void> => Promise.resolve(),
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        chatProject: {
          getOrgDefaultCoworkEligibility,
          ensureOrgDefaultCoworkWorkspace,
        },
      },
    });
    const probe: { current: OrgDefaultChatsWorkspaceState | null } = {
      current: null,
    };

    act(() => {
      root.render(<Harness probe={probe} />);
    });
    await flush();

    expect(probe.current?.workspace).toBeUndefined();
    expect(ensureOrgDefaultCoworkWorkspace).not.toHaveBeenCalled();

    // The capability arrives on an account refresh; main re-broadcasts.
    eligibility = 'eligible';
    act(() => {
      useWorkspaceContextStore
        .getState()
        .applyBroadcast({ ...ORG_STATE, reason: 'organizations' });
    });
    await flush();

    expect(probe.current?.workspace?.id).toBe(orgDefaultCoworkWorkspaceId(ORG));
    expect(probe.current?.pending).toBe(true);
    expect(ensureOrgDefaultCoworkWorkspace).toHaveBeenCalledWith(ORG);
  });
});
