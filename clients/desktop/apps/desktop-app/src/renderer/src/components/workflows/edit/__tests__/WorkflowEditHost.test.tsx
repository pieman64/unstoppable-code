/**
 * @jest-environment jsdom
 *
 * CAN-4072: the edit shell's host picks the adapter for the target's kind,
 * keys it by the item so another item never reuses a draft, and holds a
 * project pipeline until the selected worktree's checkout is known.
 */
import { useEffect, type JSX } from 'react';

const mockMounts: string[] = [];

function MockAdapter({
  name,
  props,
}: {
  name: string;
  props: Record<string, unknown>;
}): JSX.Element {
  const key = typeof props.targetKey === 'string' ? props.targetKey : '';
  useEffect(() => {
    mockMounts.push(`${name}:${key}`);
  }, [name, key]);
  return (
    <div
      data-testid={`mock-${name}`}
      data-target-key={key}
      data-section={typeof props.section === 'string' ? props.section : ''}
      data-back-label={
        typeof props.backLabel === 'string' ? props.backLabel : ''
      }
      data-props={JSON.stringify(
        Object.fromEntries(
          Object.entries(props).filter(
            ([prop]) => prop !== 'pipelines' && prop !== 'automations',
          ),
        ),
      )}
    />
  );
}

jest.mock('../PipelineEditAdapter', () => ({
  PipelineEditAdapter: (props: Record<string, unknown>): JSX.Element => (
    <MockAdapter name="pipeline-adapter" props={props} />
  ),
}));
jest.mock('../AutomationEditAdapter', () => ({
  AutomationEditAdapter: (props: Record<string, unknown>): JSX.Element => (
    <MockAdapter name="automation-adapter" props={props} />
  ),
}));
jest.mock('../SharedAutomationEditAdapter', () => ({
  SharedAutomationEditAdapter: (
    props: Record<string, unknown>,
  ): JSX.Element => (
    <MockAdapter name="shared-automation-adapter" props={props} />
  ),
}));
jest.mock('@/components/shared/PageTitlebar', () => ({
  PageTitlebar: (): null => null,
}));

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  workflowEditKey,
  type WorkflowEditTarget,
} from '@/lib/workflows/edit-target';
import type { PipelinesPageListApi } from '../../../pages/PipelinesPage';
import { WorkflowEditHost } from '../WorkflowEditHost';
import { automationsApi, pipelinesApi } from './pipelineEditMocks';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let container: HTMLDivElement;
let root: Root;
const automations = automationsApi();

function render(
  target: WorkflowEditTarget,
  pipelines: PipelinesPageListApi = pipelinesApi(),
): void {
  act(() => {
    root.render(
      <WorkflowEditHost
        target={target}
        pipelines={pipelines}
        automations={automations}
      />,
    );
  });
}

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function propsOf(testId: string): Record<string, unknown> {
  const raw = byTestId(testId)?.dataset.props;
  if (raw === undefined) throw new Error(`No ${testId}`);
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return {};
  return Object.fromEntries(Object.entries(parsed));
}

beforeEach(() => {
  mockMounts.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('WorkflowEditHost', () => {
  it('opens a pipeline on Definition with Back to the Library', () => {
    const target: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'review',
    };
    render(target);

    const adapter = byTestId('mock-pipeline-adapter');
    expect(adapter?.dataset.targetKey).toBe(workflowEditKey(target));
    expect(adapter?.dataset.section).toBe('definition');
    expect(adapter?.dataset.backLabel).toBe('Library');
    expect(byTestId('workflow-edit-host')).not.toBeNull();
  });

  it('names the item Back returns to', () => {
    render({
      kind: 'automation',
      activityId: 'a-1',
      section: 'trigger',
      returnTo: { kind: 'pipeline', pipelineId: 'review', section: 'trigger' },
    });

    const adapter = byTestId('mock-automation-adapter');
    expect(adapter?.dataset.backLabel).toBe('Pipeline');
    expect(adapter?.dataset.section).toBe('trigger');
  });

  it("holds a project pipeline until the worktree's checkout resolves", () => {
    const target: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'project-review',
      cwd: '/repo-a',
      filePath: '/repo-a/.canopy/pipelines/review.yml',
    };
    render(target, pipelinesApi({ projectContextPending: true }));

    expect(byTestId('mock-pipeline-adapter')).toBeNull();
    expect(byTestId('workflow-edit-host')).not.toBeNull();

    render(
      target,
      pipelinesApi({
        projectContext: {
          cwd: '/repo-a',
          worktree: { projectId: 'project-a', worktreeId: 'worktree-a' },
        },
      }),
    );
    expect(byTestId('mock-pipeline-adapter')).not.toBeNull();
  });

  it('keeps an open project pipeline mounted when another worktree resolves', () => {
    const target: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'project-review',
      cwd: '/repo-a',
      filePath: '/repo-a/.canopy/pipelines/review.yml',
    };
    render(target);
    expect(mockMounts).toHaveLength(1);

    // Selecting another worktree re-resolves the checkout; the open editor
    // and its unsaved edits stay.
    render(target, pipelinesApi({ projectContextPending: true }));
    expect(byTestId('mock-pipeline-adapter')).not.toBeNull();
    expect(mockMounts).toHaveLength(1);
  });

  it('opens a user pipeline while a worktree checkout still resolves', () => {
    render(
      { kind: 'pipeline', pipelineId: 'review' },
      pipelinesApi({ projectContextPending: true }),
    );

    expect(byTestId('mock-pipeline-adapter')).not.toBeNull();
  });

  it('remounts for another item but not for another section', () => {
    const review: WorkflowEditTarget = {
      kind: 'pipeline',
      pipelineId: 'review',
    };
    render(review);
    render({ ...review, section: 'runs' });
    expect(mockMounts).toHaveLength(1);

    render({ kind: 'pipeline', pipelineId: 'release' });
    expect(mockMounts).toHaveLength(2);

    // Two drafts are two items.
    render({ kind: 'pipeline', pipelineId: null, draftKey: 'draft-a' });
    render({ kind: 'pipeline', pipelineId: null, draftKey: 'draft-b' });
    expect(mockMounts).toHaveLength(4);
  });

  it('hands each automation kind to its adapter', () => {
    render({ kind: 'automation', activityId: 'a-1' });
    expect(propsOf('mock-automation-adapter')).toMatchObject({
      kind: 'automation',
      activityId: 'a-1',
    });

    const seed = { projectId: 'project-a', isCowork: false };
    render({ kind: 'automation-draft', draftKey: 'draft-c', seed });
    expect(propsOf('mock-automation-adapter')).toMatchObject({
      kind: 'automation-draft',
      seed,
    });

    render({
      kind: 'shared-automation',
      remoteId: 'remote-1',
      name: 'Weekly digest',
    });
    expect(propsOf('mock-shared-automation-adapter')).toMatchObject({
      remoteId: 'remote-1',
      fallbackName: 'Weekly digest',
    });
    expect(byTestId('mock-pipeline-adapter')).toBeNull();
  });
});
