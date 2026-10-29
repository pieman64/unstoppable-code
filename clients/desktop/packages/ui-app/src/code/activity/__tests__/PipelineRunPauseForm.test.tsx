/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PipelineRunPauseForm } from '../pipeline/PipelineRunPauseForm';
import type { PipelineRunDetailPauseCheckpoint } from '../pipeline/PipelineRunDetailModel';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const checkpoint: PipelineRunDetailPauseCheckpoint = {
  id: 'pause-review',
  kind: 'input',
  job_id: 'review',
  logical_job_id: 'review',
  step_id: 'approval',
  request: {
    fields: [
      { key: 'reviewer', label: 'Reviewer', type: 'string', required: true },
      { key: 'notes', label: 'Notes', type: 'string', multiline: true },
      { key: 'retries', label: 'Retries', type: 'number' },
      { key: 'approved', label: 'Approved', type: 'boolean' },
      {
        key: 'channel',
        label: 'Channel',
        type: 'choice',
        options: ['stable', 'beta'],
      },
    ],
  },
};

describe('PipelineRunPauseForm', () => {
  let container: HTMLDivElement;
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

  it('draws every pause field with the shared field controls', () => {
    act(() =>
      root.render(
        <PipelineRunPauseForm
          checkpoints={[checkpoint]}
          onSubmit={jest.fn()}
        />,
      ),
    );

    // The border role is not a fill: no control paints itself with it.
    expect(container.querySelector('.bg-line-base')).toBeNull();
    // Text, number, multiline, and choice share the field edge that
    // TextInput, TextArea, and Select draw.
    for (const key of ['reviewer', 'notes', 'retries', 'channel']) {
      const control = container.querySelector(
        `[data-testid="portal-pipeline-pause-field-${key}"]`,
      );
      expect(control?.classList.contains('shadow-field')).toBe(true);
    }
  });
});
