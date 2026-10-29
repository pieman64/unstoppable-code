/**
 * @jest-environment jsdom
 */
// CAN-3119 (F2): `PipelineRunArtifactCard` opens the pipeline report in
// `PipelineReportModal`. `DialogModal` records its card, so the report body
// must carry its own block. This pins that the rendered report text sits in a
// blocked region inside the recorded card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PipelineReportModal } from '../PipelineReportModal';
import { expectBlockedInRecordedDialogCard } from '@/test-utils/replay';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REPORT_TEXT = 'Rotated the production signing key for customer Acme.';

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('PipelineReportModal session replay', () => {
  const originalPipelines = Object.getOwnPropertyDescriptor(
    window,
    'pipelines',
  );
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        readReportFile: jest.fn().mockResolvedValue({
          success: true,
          data: { content: `# Summary\n\n${REPORT_TEXT}\n` },
        }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalPipelines) {
      Object.defineProperty(window, 'pipelines', originalPipelines);
    } else {
      Reflect.deleteProperty(window, 'pipelines');
    }
  });

  it('blocks the report body inside the recorded DialogModal card', async () => {
    act(() => {
      root.render(
        <PipelineReportModal
          executionId="exec-1"
          pipelineName="Release pipeline"
          onClose={(): void => undefined}
        />,
      );
    });
    await flushAsync();

    const paragraph = Array.from(document.querySelectorAll('p')).find(
      (candidate) => candidate.textContent === REPORT_TEXT,
    );
    if (paragraph === undefined) throw new Error('Report text not rendered');
    expect(container.contains(paragraph)).toBe(false);
    const card = expectBlockedInRecordedDialogCard(paragraph);
    expect(card.getAttribute('data-testid')).toBe(
      'pipeline-report-modal-exec-1',
    );
  });
});
