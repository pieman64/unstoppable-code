/**
 * @jest-environment jsdom
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';
import {
  buildPipelineDetailUiState,
  PIPELINE_DETAIL_MODAL_UI_STATE_KEY,
} from '@/lib/current-ui-state/pipelineDetailUiState';

const DETAIL_MODAL_SOURCE = readFileSync(
  join(__dirname, '..', 'PipelineExecutionDetailModal.tsx'),
  'utf-8',
);
const DETAIL_SOURCE = readFileSync(
  join(__dirname, '..', 'details', 'PipelineExecutionDetail.tsx'),
  'utf-8',
);
const PIPELINE_RUNS_SOURCE = readFileSync(
  join(__dirname, '..', 'PipelineRunsSection.tsx'),
  'utf-8',
);
const PANEL_SOURCE = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    'panels',
    'pipeline',
    'PipelineExecutionPanel.tsx',
  ),
  'utf-8',
);

describe('PipelineExecutionDetailModal current UI reporting', () => {
  it('reports pause metadata for the active breadcrumb execution', () => {
    expect(PIPELINE_DETAIL_MODAL_UI_STATE_KEY).toBe('pipelineRuns.detailModal');
    // Only the live (compatibility) modal reports under the fixed key;
    // archived views don't.
    expect(DETAIL_MODAL_SOURCE).toContain(
      '? PIPELINE_DETAIL_MODAL_UI_STATE_KEY',
    );
    // Each run panel reports under its own key, never the modal's.
    expect(PANEL_SOURCE).toContain('pipelineDetailPanelUiStateKey(uiKey)');
    expect(PANEL_SOURCE).not.toContain('PIPELINE_DETAIL_MODAL_UI_STATE_KEY');
    expect(DETAIL_SOURCE).toContain('executionId: activeExecutionId');
    expect(DETAIL_SOURCE).toContain('buildPipelineDetailUiState({');
    expect(PIPELINE_RUNS_SOURCE).not.toContain("'pipelineRuns.detailModal'");
    expect(PIPELINE_RUNS_SOURCE).not.toContain('PipelineExecutionDetailModal');
  });

  it.each([
    {
      label: 'structured input pause',
      pendingPauses: [{ kind: 'input', request: { fields: [] } }],
      expected: { inputRequired: true, resumable: false },
    },
    {
      label: 'action pause',
      pendingPauses: [{ kind: 'action' }],
      expected: { inputRequired: false, resumable: true },
    },
  ])(
    'reports a nested $label from the active child state',
    ({ pendingPauses, expected }) => {
      expect(
        buildPipelineDetailUiState({
          executionId: 'child-execution',
          summary: { pipeline_id: 'child-pipeline', status: 'paused' },
          state: {
            pipeline_id: 'child-pipeline',
            status: 'paused',
            pending_pauses: pendingPauses,
            status_reasons: [
              {
                id: 'child-reason',
                kind: 'action_paused',
                code: 'action_requested_pause',
                source: { job_id: 'child-job', step_id: 'child-step' },
              },
            ],
          },
        }),
      ).toMatchObject({
        executionId: 'child-execution',
        ...expected,
        resumableStatusReasons: [
          {
            id: 'child-reason',
            jobId: 'child-job',
            stepId: 'child-step',
          },
        ],
      });
    },
  );

  it('reports transient retry metadata for the active execution', () => {
    const state = {
      pipeline_id: 'pipeline-1',
      status: 'paused',
      pending_pauses: [],
      status_reasons: [],
      transient_retry: {
        attempt: 2,
        maxAttempts: 4,
        nextRetryAt: 60_000,
        exhausted: false,
      },
    } as const;

    expect(
      buildPipelineDetailUiState({
        executionId: 'execution-1',
        state,
      }),
    ).toMatchObject({
      transientRetry: {
        attempt: 2,
        maxAttempts: 4,
        nextRetryAt: 60_000,
        exhausted: false,
      },
    });
  });
});
