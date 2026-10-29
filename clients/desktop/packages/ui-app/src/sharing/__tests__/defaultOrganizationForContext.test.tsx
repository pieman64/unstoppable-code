/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  ContextChangedNotice,
  contextLabel,
  defaultOrganizationForContext,
  useContextRebind,
} from '../defaultOrganizationForContext';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const orgA: WorkspaceContext = { kind: 'organization', organizationId: ORG_A };
const orgB: WorkspaceContext = { kind: 'organization', organizationId: ORG_B };
const personal: WorkspaceContext = { kind: 'personal' };

describe('defaultOrganizationForContext', () => {
  const both = [{ id: ORG_A }, { id: ORG_B }];

  it('returns the context organization when it is eligible', () => {
    expect(defaultOrganizationForContext(orgB, both)).toBe(ORG_B);
  });

  it('matches the context organization case-insensitively', () => {
    expect(
      defaultOrganizationForContext(orgA, [{ id: ORG_A.toUpperCase() }]),
    ).toBe(ORG_A.toUpperCase());
  });

  it('returns null when the context organization is not eligible', () => {
    expect(defaultOrganizationForContext(orgB, [{ id: ORG_A }])).toBeNull();
  });

  it('returns null in Personal context, even with one organization', () => {
    expect(defaultOrganizationForContext(personal, [{ id: ORG_A }])).toBeNull();
  });

  it('picks the only organization when there is no context', () => {
    expect(defaultOrganizationForContext(undefined, [{ id: ORG_A }])).toBe(
      ORG_A,
    );
  });

  it('never guesses among several organizations without a context', () => {
    expect(defaultOrganizationForContext(undefined, both)).toBeNull();
    expect(defaultOrganizationForContext(undefined, [])).toBeNull();
  });
});

describe('contextLabel', () => {
  it('names Personal and organizations', () => {
    const organizations = [{ id: ORG_A, name: 'Org A' }];
    expect(contextLabel(personal, organizations)).toBe('Personal');
    expect(contextLabel(orgA, organizations)).toBe('Org A');
  });

  it('disambiguates duplicate organization names', () => {
    expect(
      contextLabel(orgA, [
        { id: ORG_A, name: 'Acme' },
        { id: ORG_B, name: 'Acme' },
      ]),
    ).toBe('Acme (111111)');
  });
});

describe('useContextRebind', () => {
  let container: HTMLElement;
  let root: Root;
  const calls: [WorkspaceContext, WorkspaceContext][] = [];

  function Harness({
    context,
    paused = false,
  }: {
    context: WorkspaceContext | undefined;
    paused?: boolean;
  }): JSX.Element {
    useContextRebind(
      context,
      (next, previous) => {
        calls.push([next, previous]);
      },
      paused,
    );
    return <span />;
  }

  beforeEach(() => {
    calls.length = 0;
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function render(context: WorkspaceContext | undefined, paused = false): void {
    act(() => root.render(<Harness context={context} paused={paused} />));
  }

  it('does not fire on hydration from undefined', () => {
    render(undefined);
    render(orgA);
    expect(calls).toEqual([]);
  });

  it('fires when a defined context changes', () => {
    render(orgA);
    render({ kind: 'organization', organizationId: ORG_A });
    expect(calls).toEqual([]);
    render(orgB);
    expect(calls).toEqual([[orgB, orgA]]);
    render(undefined);
    render(personal);
    expect(calls).toEqual([[orgB, orgA]]);
  });

  it('defers a context change while paused and applies it after resuming', () => {
    render(orgA);
    render(orgB, true);
    expect(calls).toEqual([]);

    render(orgB, false);
    expect(calls).toEqual([[orgB, orgA]]);
  });
});

describe('ContextChangedNotice', () => {
  it('names the new context', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(<ContextChangedNotice label="Org B" data-testid="notice" />),
    );
    expect(
      container.querySelector('[data-testid="notice"]')?.textContent,
    ).toContain('Switched to Org B.');
    act(() => root.unmount());
  });
});
