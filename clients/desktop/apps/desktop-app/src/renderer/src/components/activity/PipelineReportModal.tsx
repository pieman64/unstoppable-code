import { useEffect, useState, type JSX } from 'react';
import { loadPipelineReportContent } from '@/lib/pipelineExecutionDetail';
import { DialogModal } from '../shared/DialogModal';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { PipelineReportMarkdown } from './PipelineReportMarkdown';

interface PipelineReportModalProps {
  executionId: string;
  pipelineName: string;
  onClose: () => void;
  ownerDocument?: Document;
}

export function PipelineReportModal({
  executionId,
  pipelineName,
  onClose,
  ownerDocument,
}: PipelineReportModalProps): JSX.Element {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);

    void loadPipelineReportContent(
      (currentExecutionId, kind) =>
        window.pipelines.readReportFile(currentExecutionId, kind),
      executionId,
    )
      .then((result) => {
        if (cancelled) return;
        if (result.error) {
          setError(result.error);
          return;
        }
        setContent(result.content ?? null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load report');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });

    return (): void => {
      cancelled = true;
    };
  }, [executionId]);

  return (
    <DialogModal
      onClose={onClose}
      title="Workflow report"
      subtitle={pipelineName}
      maxWidth="3xl"
      dataTestId={`pipeline-report-modal-${executionId}`}
      ownerDocument={ownerDocument}
    >
      <div className="overflow-y-auto">
        {loading ? (
          <div className="flex items-center text-s fg-secondary">
            <LoadingSpinner tone="active" className="mr-2" />
            Loading report…
          </div>
        ) : error ? (
          <div className="text-s fg-destructive-strong">{error}</div>
        ) : content ? (
          <PipelineReportMarkdown content={content} />
        ) : (
          <div className="text-s fg-secondary">No report content</div>
        )}
      </div>
    </DialogModal>
  );
}
