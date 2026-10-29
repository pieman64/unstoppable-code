/**
 * Rendering helpers for the pipeline edit shell suites (CAN-4072). The shell
 * renders through `WorkflowEditHost` from the navigation store's
 * `workflowEdit`, as `WorkflowsPage` does, so opening, replacing and closing
 * a target behave as in the app. Import this after the suite's `jest.mock`
 * calls (Jest hoists them).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkflowEditTarget } from '@/lib/workflows/edit-target';
import { useNavigationStore } from '@/stores/navigationStore';
import type { AutomationsPageBodyApi } from '../../../pages/AutomationsPage';
import type { PipelinesPageListApi } from '../../../pages/PipelinesPage';
import { automationsApi, pipelinesApi } from './pipelineEditMocks';
import {
  PipelineShellHarness,
  type PipelineShellHarnessProps,
} from './PipelineShellHarness';

export { automationsApi, pipelinesApi };

let root: Root | null = null;

export interface RenderedShell {
  readonly pipelines: PipelinesPageListApi;
  readonly automations: AutomationsPageBodyApi;
  /** Draws the harness again, e.g. after changing a mock editor. */
  readonly rerender: () => void;
}

/** Opens `target` in the shell on the Library, as a Library row does. */
export function renderShell(
  target: WorkflowEditTarget,
  props: Partial<PipelineShellHarnessProps> = {},
): RenderedShell {
  const pipelines = props.pipelines ?? pipelinesApi();
  const automations = props.automations ?? automationsApi();
  act(() => {
    useNavigationStore.setState({
      activePage: 'workflows-library',
      workflowEdit: target,
    });
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const mounted = createRoot(container);
  root = mounted;
  const draw = (): void => {
    act(() => {
      mounted.render(
        <PipelineShellHarness
          pipelines={pipelines}
          automations={automations}
        />,
      );
    });
  };
  draw();
  return { pipelines, automations, rerender: draw };
}

export function unmountShell(): void {
  const mounted = root;
  root = null;
  if (mounted) act(() => mounted.unmount());
  document.body.innerHTML = '';
}

export function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

export function click(element: Element | null | undefined): void {
  if (!element) throw new Error('Nothing to click');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Opens the shell's More menu: Turn on/off, Duplicate and Delete. */
export function openMoreMenu(): void {
  click(byTestId('workflow-edit-more'));
}

/** Lets pending promise chains settle. */
export async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

/** Lets a `setTimeout(0)` and the renders it causes run. */
export async function flushTimers(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await flush();
}

/** A ⌘-chord on the window, as the app's shortcuts read it. */
export function pressMod(
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

export function shownTarget(): WorkflowEditTarget | undefined {
  return useNavigationStore.getState().workflowEdit;
}
