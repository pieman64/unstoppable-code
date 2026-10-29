import {
  formatPipelineReportContent,
  getDisplayablePipelineStepInputs,
  getDisplayablePipelineStepOutputs,
  getDefaultPipelineLogViewMode,
  hasRenderableRichTranscript,
  loadPipelineReportContent,
  resolvePipelineStepLogSources,
} from '../lib/pipelineExecutionDetail';
import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import type { DisplayMessage } from '../components/chat/types';
import type { StepResult } from '@canopy/desktop-shared/types/pipeline';

function createStepResult(partial: Partial<StepResult>): StepResult {
  return {
    status: partial.status ?? 'success',
    outputs: partial.outputs ?? {},
    dynamic_env: partial.dynamic_env ?? {},
    ...partial,
  };
}

function createDisplayMessage(text: string): DisplayMessage {
  return {
    id: text,
    role: 'assistant',
    timestamp: 1,
    blocks: [{ type: 'text', text }],
  };
}

function createReportResult(
  content: string,
): IPCResult<{ content: string; filePath: string }> {
  return {
    success: true,
    data: {
      content,
      filePath: '/tmp/report',
    },
  };
}

describe('pipelineExecutionDetail helpers', () => {
  it('prefers transcript_file as the rich log source for agent-formatted steps', () => {
    expect(
      resolvePipelineStepLogSources(
        createStepResult({
          log_file: '/tmp/step.log',
          log_format_hint: 'agent',
          outputs: {
            transcript_file: '/tmp/transcript.jsonl',
          },
        }),
      ),
    ).toEqual({
      plainLogFile: '/tmp/step.log',
      richLogFile: '/tmp/transcript.jsonl',
    });
  });

  it('falls back to log_file for rich logs when transcript_file is absent', () => {
    expect(
      resolvePipelineStepLogSources(
        createStepResult({
          log_file: '/tmp/step.log',
          log_format_hint: 'agent',
        }),
      ),
    ).toEqual({
      plainLogFile: '/tmp/step.log',
      richLogFile: '/tmp/step.log',
    });
  });

  it('does not enable rich logs for non-agent steps', () => {
    expect(
      resolvePipelineStepLogSources(
        createStepResult({
          log_file: '/tmp/step.log',
        }),
      ),
    ).toEqual({
      plainLogFile: '/tmp/step.log',
      richLogFile: undefined,
    });
  });

  it('hides duplicate inline prompt and text response fields for agent-formatted steps', () => {
    expect(
      getDisplayablePipelineStepInputs(
        {
          model: 'opus',
          prompt: 'Plan this task.',
          permission_preset: 'plan',
        },
        createStepResult({
          log_format_hint: 'agent',
        }),
      ),
    ).toEqual({
      model: 'opus',
      permission_preset: 'plan',
    });

    expect(
      getDisplayablePipelineStepOutputs(
        {
          session_id: 'session-1',
          text_response: 'Proposed plan',
          json_response: '{"status":"ok"}',
          transcript_file: '/tmp/transcript.jsonl',
        },
        createStepResult({
          log_format_hint: 'agent',
        }),
      ),
    ).toEqual({
      session_id: 'session-1',
      transcript_file: '/tmp/transcript.jsonl',
    });
  });

  it('preserves inline prompt and text response fields for non-agent steps', () => {
    expect(
      getDisplayablePipelineStepInputs(
        {
          prompt: 'Plan this task.',
        },
        createStepResult({}),
      ),
    ).toEqual({
      prompt: 'Plan this task.',
    });

    expect(
      getDisplayablePipelineStepOutputs(
        {
          text_response: 'Proposed plan',
        },
        createStepResult({}),
      ),
    ).toEqual({
      text_response: 'Proposed plan',
    });
  });

  it('defaults to rich view only when renderable transcript messages exist', () => {
    expect(hasRenderableRichTranscript([createDisplayMessage('Done')])).toBe(
      true,
    );
    expect(getDefaultPipelineLogViewMode([createDisplayMessage('Done')])).toBe(
      'rich',
    );
    expect(hasRenderableRichTranscript([])).toBe(false);
    expect(getDefaultPipelineLogViewMode([])).toBe('plain');
  });

  it('pretty-prints JSON report content', () => {
    expect(formatPipelineReportContent('json', '{"status":"ok"}')).toBe(
      '{\n  "status": "ok"\n}',
    );
  });

  it('falls back to the JSON report when the text report is unavailable', async () => {
    const readReportFile = jest
      .fn<
        Promise<IPCResult<{ content: string; filePath: string }>>,
        [string, 'text' | 'json']
      >()
      .mockResolvedValueOnce({
        success: false,
        error: 'missing text report',
      })
      .mockResolvedValueOnce(createReportResult('{"status":"ok"}'));

    await expect(
      loadPipelineReportContent(readReportFile, 'exec-1'),
    ).resolves.toEqual({
      content: '{\n  "status": "ok"\n}',
    });

    expect(readReportFile).toHaveBeenNthCalledWith(1, 'exec-1', 'text');
    expect(readReportFile).toHaveBeenNthCalledWith(2, 'exec-1', 'json');
  });

  it('returns the text-read error when neither report format can be loaded', async () => {
    const readReportFile = jest
      .fn<
        Promise<IPCResult<{ content: string; filePath: string }>>,
        [string, 'text' | 'json']
      >()
      .mockResolvedValueOnce({
        success: false,
        error: 'missing text report',
      })
      .mockResolvedValueOnce({
        success: false,
        error: 'missing json report',
      });

    await expect(
      loadPipelineReportContent(readReportFile, 'exec-2'),
    ).resolves.toEqual({
      error: 'missing text report',
    });
  });
});
