/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { PipelineTableRow } from '../PipelineTableRow';

jest.mock('@/lib/share-links', () => ({
  resolveSharedPipelineUrl: (sharePath: string): Promise<string> =>
    Promise.resolve(`https://cloud.test${sharePath}`),
}));

const writeText = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText },
});

function makePipelineInfo(overrides: Partial<PipelineInfo> = {}): PipelineInfo {
  return {
    id: 'pipeline-1',
    name: 'Review',
    filename: 'review.yaml',
    description: 'Review pipeline',
    icon: '⚡',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    triggerTypes: [],
    source: 'user',
    readonly: false,
    ...overrides,
  };
}

interface RowHandlers {
  onToggleEnabled: jest.Mock;
  onEdit: jest.Mock;
  onDelete: jest.Mock;
  onDuplicate: jest.Mock;
  onShare: jest.Mock;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  writeText.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function renderRow(
  pipeline: PipelineInfo,
  options: {
    enabled?: boolean;
    withShare?: boolean;
    sharePending?: boolean;
  } = {},
): RowHandlers {
  const handlers: RowHandlers = {
    onToggleEnabled: jest.fn(() => Promise.resolve()),
    onEdit: jest.fn(),
    onDelete: jest.fn(() => Promise.resolve()),
    onDuplicate: jest.fn(() => Promise.resolve()),
    onShare: jest.fn(),
  };
  act(() => {
    root.render(
      <table>
        <tbody>
          <PipelineTableRow
            pipeline={pipeline}
            enabled={options.enabled ?? true}
            onToggleEnabled={handlers.onToggleEnabled}
            onEdit={handlers.onEdit}
            onDelete={handlers.onDelete}
            onDuplicate={handlers.onDuplicate}
            onShare={options.withShare === false ? undefined : handlers.onShare}
            sharePending={options.sharePending ?? false}
          />
        </tbody>
      </table>,
    );
  });
  return handlers;
}

function byLabel(label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
}

function byTestId(testId: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `[data-testid="${testId}"]`,
  );
}

describe('PipelineTableRow actions', () => {
  it('shows edit, share and delete for a user pipeline, and no duplicate', () => {
    renderRow(makePipelineInfo());
    expect(byLabel('Edit')).not.toBeNull();
    expect(byLabel('Share')).not.toBeNull();
    expect(byLabel('Delete')).not.toBeNull();
    expect(byLabel('Duplicate')).toBeNull();
    expect(byLabel('View')).toBeNull();
    expect(byTestId('pipeline-edit-pipeline-1')).not.toBeNull();
    expect(byTestId('pipeline-share-pipeline-1')).not.toBeNull();
    expect(byTestId('pipeline-delete-pipeline-1')).not.toBeNull();
  });

  it('shows view + duplicate and hides delete for a readonly source', () => {
    for (const source of ['bundled', 'curated', 'project'] as const) {
      renderRow(makePipelineInfo({ source, readonly: true }));
      expect(byLabel('View')).not.toBeNull();
      expect(byLabel('Edit')).toBeNull();
      expect(byLabel('Duplicate')).not.toBeNull();
      expect(byLabel('Delete')).toBeNull();
      // Share is offered for every source — non-user rows publish a snapshot.
      expect(byLabel('Share')).not.toBeNull();
    }
  });

  it('respects shared per-row canUpdate / canDelete permissions', () => {
    renderRow(
      makePipelineInfo({ source: 'shared', canUpdate: true, canDelete: true }),
    );
    expect(byLabel('Edit')).not.toBeNull();
    expect(byLabel('Delete')).not.toBeNull();
    expect(byLabel('Duplicate')).not.toBeNull();

    renderRow(
      makePipelineInfo({
        source: 'shared',
        canUpdate: false,
        canDelete: false,
      }),
    );
    expect(byLabel('View')).not.toBeNull();
    expect(byLabel('Edit')).toBeNull();
    expect(byLabel('Delete')).toBeNull();
    expect(byLabel('Duplicate')).not.toBeNull();
  });

  it('folds the enabled toggle into the action group, naming the next action', async () => {
    const handlers = renderRow(makePipelineInfo(), { enabled: true });
    const toggle = byTestId('pipeline-toggle-enabled-pipeline-1');
    expect(toggle?.getAttribute('aria-label')).toBe('Disable workflow');
    // The name already flips to describe the next action, so `aria-pressed`
    // must NOT also be set — together they announce "Disable pipeline, toggle
    // button, pressed", which contradicts itself.
    expect(toggle?.getAttribute('aria-pressed')).toBeNull();
    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    expect(handlers.onToggleEnabled).toHaveBeenCalledWith(false);

    renderRow(makePipelineInfo(), { enabled: false });
    const offToggle = byTestId('pipeline-toggle-enabled-pipeline-1');
    expect(offToggle?.getAttribute('aria-label')).toBe('Enable workflow');
    expect(offToggle?.getAttribute('aria-pressed')).toBeNull();
  });

  it('arms delete on the first click and deletes on the second', async () => {
    const handlers = renderRow(makePipelineInfo());
    const deleteButton = byTestId('pipeline-delete-pipeline-1');
    await act(async () => {
      deleteButton?.click();
      await Promise.resolve();
    });
    expect(handlers.onDelete).not.toHaveBeenCalled();
    const armed = byTestId('pipeline-delete-pipeline-1');
    expect(armed?.getAttribute('aria-label')).toBe('Confirm delete');
    // Armed state must read without hover (solid fill + ring), not via the
    // tooltip label alone.
    expect(armed?.className).toContain('bg-destructive');
    expect(armed?.className).not.toContain('bg-destructive-subtle');
    expect(armed?.className).toContain('ring-2');

    await act(async () => {
      armed?.click();
      await Promise.resolve();
    });
    expect(handlers.onDelete).toHaveBeenCalledWith('pipeline-1');
  });

  it('disarms delete when focus leaves the action group', async () => {
    renderRow(makePipelineInfo());
    const deleteButton = byTestId('pipeline-delete-pipeline-1');
    await act(async () => {
      deleteButton?.focus();
      deleteButton?.click();
      await Promise.resolve();
    });
    expect(
      byTestId('pipeline-delete-pipeline-1')?.getAttribute('aria-label'),
    ).toBe('Confirm delete');

    const outside = document.createElement('button');
    document.body.appendChild(outside);
    await act(async () => {
      outside.focus();
      await Promise.resolve();
    });
    expect(
      byTestId('pipeline-delete-pipeline-1')?.getAttribute('aria-label'),
    ).toBe('Delete');
    outside.remove();
  });

  it('raises share with the row pipeline info, and disables it while pending', () => {
    const pipeline = makePipelineInfo();
    const handlers = renderRow(pipeline);
    act(() => {
      byTestId('pipeline-share-pipeline-1')?.click();
    });
    expect(handlers.onShare).toHaveBeenCalledWith(pipeline);

    renderRow(pipeline, { sharePending: true });
    expect(byTestId('pipeline-share-pipeline-1')?.disabled).toBe(true);
  });

  it('omits share entirely when no handler is supplied', () => {
    renderRow(makePipelineInfo(), { withShare: false });
    expect(byLabel('Share')).toBeNull();
    expect(byTestId('pipeline-share-pipeline-1')).toBeNull();
  });

  it('omits the share-link action for pipelines that are not shared', () => {
    renderRow(makePipelineInfo());
    expect(byTestId('pipeline-copy-link-pipeline-1')).toBeNull();
  });

  it('copies the public link when one exists', async () => {
    renderRow(
      makePipelineInfo({
        source: 'shared',
        remoteId: 'remote-1',
        shareScope: 'private',
        publicShare: {
          externalId: 'public-1',
          pinnedContentHash: 'hash',
          upToDate: true,
          sharePath: '/portal/plugins/pipelines/shared/public-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );
    const button = byTestId('pipeline-copy-link-pipeline-1');
    expect(button?.getAttribute('aria-label')).toBe('Copy share link');
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(
      'https://cloud.test/portal/plugins/pipelines/shared/public-1',
    );
  });

  it.each(['team', 'organization'] as const)(
    'copies the scoped share link for a %s-shared pipeline',
    async (shareScope) => {
      const handlers = renderRow(
        makePipelineInfo({
          source: 'shared',
          remoteId: 'remote-1',
          shareScope,
        }),
      );
      const button = byTestId('pipeline-copy-link-pipeline-1');
      expect(button?.getAttribute('aria-label')).toBe('Copy share link');
      await act(async () => {
        button?.click();
        await Promise.resolve();
      });
      expect(writeText).toHaveBeenCalledWith(
        'https://cloud.test/portal/plugins/pipelines/shared/remote-1',
      );
      expect(handlers.onEdit).not.toHaveBeenCalled();
    },
  );

  it('offers no link action for a hidden private-only share', () => {
    const pipeline = makePipelineInfo({
      source: 'shared',
      remoteId: 'remote-1',
      shareScope: 'private',
      canUpdate: true,
    });
    const handlers = renderRow(pipeline);
    const button = byTestId('pipeline-copy-link-pipeline-1');
    expect(button).toBeNull();
    expect(handlers.onEdit).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('PipelineTableRow description', () => {
  function descriptionLine(): HTMLParagraphElement | null {
    return container.querySelector<HTMLParagraphElement>('h3 + p');
  }

  it('shows a Markdown description as one plain-text line', () => {
    renderRow(
      makePipelineInfo({
        description: '**Reviews** PRs\n\n1. Lints\n2. Tests',
      }),
    );
    expect(descriptionLine()?.textContent).toBe('Reviews PRs. Lints. Tests');
  });

  it('hides the line when the description has no visible text', () => {
    renderRow(makePipelineInfo({ description: '---' }));
    expect(descriptionLine()).toBeNull();
  });
});
