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
): HTMLButtonElement {
  const el = container.querySelector(
    `[data-testid="pipeline-execution-scope-row-${scope}"]`,
  );
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`Missing scope choice for ${scope}`);
  }
  return el;
}

function isChecked(el: HTMLElement): boolean {
  return el.getAttribute('aria-checked') === 'true';
}

describe('PipelineSettingsPanel execution scope', () => {
  it('renders automation-addressable execution scope controls', () => {
    const { container, root } = render(makePipeline('directory'));
    expect(
      container.querySelector('[data-testid="pipeline-execution-scope"]')
        ?.textContent,
    ).toContain('Execution scope');
    expect(scopeCheckbox(container, 'global')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(scopeCheckbox(container, 'directory')).toBeInstanceOf(
      HTMLButtonElement,
    );
    expect(scopeCheckbox(container, 'worktree')).toBeInstanceOf(
      HTMLButtonElement,
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
    expect(isChecked(scopeCheckbox(container, 'directory'))).toBe(true);
    expect(isChecked(scopeCheckbox(container, 'worktree'))).toBe(false);
    expect(isChecked(scopeCheckbox(container, 'global'))).toBe(false);
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

describe('PipelineSettingsPanel choice rows', () => {
  it('leaves the trigger and scope rows enabled when editable', () => {
    const { container, root } = render(makePipeline(['global', 'worktree']));
    expect(
      row(container, 'pipeline-trigger-row-dispatch').hasAttribute('disabled'),
    ).toBe(false);
    expect(
      row(container, 'pipeline-execution-scope-row-global').hasAttribute(
        'disabled',
      ),
    ).toBe(false);
    act((): void => root.unmount());
  });

  it('disables rows that cannot be toggled', () => {
    // Readonly rows, and the last remaining scope, are not click targets.
    const { container: readonlyContainer, root: readonlyRoot } = render(
      makePipeline(['global', 'worktree']),
      true,
    );
    for (const testId of [
      'pipeline-trigger-row-dispatch',
      'pipeline-execution-scope-row-global',
    ]) {
      expect(row(readonlyContainer, testId).hasAttribute('disabled')).toBe(
        true,
      );
    }
    act((): void => readonlyRoot.unmount());

    const { container, root } = render(makePipeline('directory'));
    expect(
      row(container, 'pipeline-execution-scope-row-directory').hasAttribute(
        'disabled',
      ),
    ).toBe(true);
    act((): void => root.unmount());
  });
});
