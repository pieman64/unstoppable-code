/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  Pipeline,
  PipelineExecutionScope,
} from '@canopy/desktop-shared/types/pipeline';
import { PipelineSettingsPanel } from '../PipelineSettingsPanel';

function makePipeline(scope?: Pipeline['scope']): Pipeline {
  return {
    name: 'Test',
    description: '',
    icon: '',
    on: 'dispatch',
    jobs: {},
    ...(scope !== undefined ? { scope } : {}),
  };
}

interface Rendered {
  container: HTMLElement;
  root: Root;
  onUpdateField: jest.Mock;
}

function render(pipeline: Pipeline, readonly = false): Rendered {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onUpdateField = jest.fn();
  act((): void => {
    root.render(
      <PipelineSettingsPanel
        pipeline={pipeline}
        onUpdateField={onUpdateField}
        onUpdateDefaults={(): void => {}}
        onUpdateEnv={(): void => {}}
        relatedDataRevision={0}
        onRelatedNavigate={(navigate): void => navigate()}
        readonly={readonly}
      />,
    );
  });
  return { container, root, onUpdateField };
}

function scopeCheckbox(
  container: HTMLElement,
  scope: PipelineExecutionScope,
): HTMLInputElement {
  const el = container.querySelector(
    `[data-testid="pipeline-execution-scope-${scope}"]`,
  );
  if (!(el instanceof HTMLInputElement)) {
    throw new Error(`Missing scope checkbox for ${scope}`);
  }
  return el;
}

describe('PipelineSettingsPanel execution scope', () => {
  it('renders automation-addressable execution scope controls', () => {
    const { container, root } = render(makePipeline('directory'));
    expect(
      container.querySelector('[data-testid="pipeline-execution-scope"]')
        ?.textContent,
    ).toContain('Execution scope');
    expect(scopeCheckbox(container, 'global')).toBeInstanceOf(HTMLInputElement);
    expect(scopeCheckbox(container, 'directory')).toBeInstanceOf(
      HTMLInputElement,
    );
    expect(scopeCheckbox(container, 'worktree')).toBeInstanceOf(
      HTMLInputElement,
    );
    act((): void => root.unmount());
  });

  it('writes a multi-scope selection as an array', () => {
    const { container, root, onUpdateField } = render(
      makePipeline('directory'),
    );
    act((): void => {
      scopeCheckbox(container, 'worktree').click();
    });
    expect(onUpdateField).toHaveBeenCalledWith('scope', [
      'directory',
      'worktree',
    ]);
    act((): void => root.unmount());
  });

  it('writes a single remaining scope as a string', () => {
    const { container, root, onUpdateField } = render(
      makePipeline(['directory', 'worktree']),
    );
    act((): void => {
      scopeCheckbox(container, 'directory').click();
    });
    expect(onUpdateField).toHaveBeenCalledWith('scope', 'worktree');
    act((): void => root.unmount());
  });

  it('defaults a missing scope to Directory selected', () => {
    const { container, root } = render(makePipeline());
    expect(scopeCheckbox(container, 'directory').checked).toBe(true);
    expect(scopeCheckbox(container, 'worktree').checked).toBe(false);
    expect(scopeCheckbox(container, 'global').checked).toBe(false);
    act((): void => root.unmount());
  });

  it('disables the final selected scope so at least one stays selected', () => {
    const { container, root, onUpdateField } = render(
      makePipeline('directory'),
    );
    const directory = scopeCheckbox(container, 'directory');
    expect(directory.disabled).toBe(true);
    act((): void => {
      directory.click();
    });
    expect(onUpdateField).not.toHaveBeenCalled();
    act((): void => root.unmount());
  });

  it('disables every scope control for readonly pipelines', () => {
    const { container, root } = render(
      makePipeline(['global', 'worktree']),
      true,
    );
    expect(scopeCheckbox(container, 'global').disabled).toBe(true);
    expect(scopeCheckbox(container, 'directory').disabled).toBe(true);
    expect(scopeCheckbox(container, 'worktree').disabled).toBe(true);
    act((): void => root.unmount());
  });
});

function row(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`Missing row ${testId}`);
  return el;
}

describe('PipelineSettingsPanel row hover', () => {
  // These rows are the panel's only click targets and they went flat when
  // `hover:bg-surface-hover` was removed as a dead class (#3791): no
  // stylesheet declared that role, so the highlight never painted. The app's
  // row idiom is `hover:bg-subtle` (DropdownMenuItem, the sidebar rows,
  // SidebarPageNav); `hover:bg-secondary` is the opaque button/chip hover.
  it('highlights the enabled trigger rows', () => {
    const { container, root } = render(makePipeline('directory'));
    const manual = row(container, 'pipeline-trigger-row-dispatch');
    expect(manual.classList.contains('hover:bg-subtle')).toBe(true);
    expect(manual.classList.contains('cursor-pointer')).toBe(true);
    act((): void => root.unmount());
  });

  it('highlights the enabled execution-scope rows', () => {
    const { container, root } = render(makePipeline(['global', 'worktree']));
    const global = row(container, 'pipeline-execution-scope-row-global');
    expect(global.classList.contains('hover:bg-subtle')).toBe(true);
    expect(global.classList.contains('cursor-pointer')).toBe(true);
    act((): void => root.unmount());
  });

  it('leaves rows that cannot be toggled without a hover highlight', () => {
    // Readonly rows, and the last remaining scope, are not click targets, so
    // a highlight would promise an interaction that does nothing.
    const { container: readonlyContainer, root: readonlyRoot } = render(
      makePipeline(['global', 'worktree']),
      true,
    );
    for (const testId of [
      'pipeline-trigger-row-dispatch',
      'pipeline-execution-scope-row-global',
    ]) {
      const el = row(readonlyContainer, testId);
      expect(el.classList.contains('hover:bg-subtle')).toBe(false);
      expect(el.classList.contains('opacity-70')).toBe(true);
    }
    act((): void => readonlyRoot.unmount());

    const { container, root } = render(makePipeline('directory'));
    const lastScope = row(container, 'pipeline-execution-scope-row-directory');
    expect(lastScope.classList.contains('hover:bg-subtle')).toBe(false);
    expect(lastScope.classList.contains('opacity-70')).toBe(true);
    act((): void => root.unmount());
  });
});
