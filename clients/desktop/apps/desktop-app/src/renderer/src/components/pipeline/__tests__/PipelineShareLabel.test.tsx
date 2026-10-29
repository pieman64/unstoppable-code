/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelineShareOwner } from '@canopy/desktop-shared/types/pipeline';
import { PipelineShareLabel } from '../PipelineShareLabel';

describe('PipelineShareLabel', () => {
  let container: HTMLElement;
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

  const team: PipelineShareOwner = {
    type: 'team',
    id: 'team-1',
    name: 'Platform',
    organization: {
      id: 'org-1',
      name: 'Acme',
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    },
  };

  function label(): HTMLElement | null {
    return container.querySelector('span');
  }

  it('names the team inline instead of behind a hover', () => {
    act(() => {
      root.render(<PipelineShareLabel shareScope="team" owner={team} />);
    });
    expect(container.textContent).toBe('Team: Platform');
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('reads Organization for an organization share', () => {
    act(() => {
      root.render(
        <PipelineShareLabel
          shareScope="organization"
          owner={{ type: 'organization', id: 'org-1', name: 'Acme' }}
        />,
      );
    });
    expect(container.textContent).toBe('Organization');
  });

  it('reads Shared for a personal cloud copy or a row with no scope', () => {
    act(() => {
      root.render(<PipelineShareLabel shareScope="private" />);
    });
    expect(container.textContent).toBe('Shared');
    act(() => {
      root.render(<PipelineShareLabel />);
    });
    expect(container.textContent).toBe('Shared');
  });

  it('is quiet text, not a pill, for every scope', () => {
    for (const shareScope of ['team', 'organization', 'private'] as const) {
      act(() => {
        root.render(
          <PipelineShareLabel shareScope={shareScope} owner={team} />,
        );
      });
      expect(label()?.className).toContain('fg-tertiary');
      expect(label()?.className).not.toMatch(/\b(bg-|ring-|rounded|border)/);
    }
  });
});
