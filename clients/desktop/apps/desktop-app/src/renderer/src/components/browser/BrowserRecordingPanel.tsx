import { useState, type JSX } from 'react';
import { CHAT_UNIT_LABEL } from '@canopy/protocol';
import { ChatIcon, TrashIcon } from '@canopy/ui-shared/icons';
import { useBrowserStore } from '@/stores/browserStore';
import { stageBrowserRecording } from '@/lib/browserChatStaging';
import { Button, Tooltip } from '@canopy/ui-shared';

interface BrowserRecordingPanelProps {
  browserId: string;
}

export function BrowserRecordingPanel({
  browserId,
}: BrowserRecordingPanelProps): JSX.Element {
  const recording = useBrowserStore((s) => s.recordings[browserId]);
  const setRecordingResult = useBrowserStore((s) => s.setRecordingResult);
  const clearRecording = useBrowserStore((s) => s.clearRecording);
  const [busy, setBusy] = useState(false);

  const isRecording = recording?.recording ?? false;
  const steps = recording?.steps ?? [];
  const script = recording?.playwrightScript ?? '';

  const handleStop = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await window.api.browser.stopRecording({ browserId });
      setRecordingResult(browserId, result);
    } finally {
      setBusy(false);
    }
  };

  const handleAttach = async (): Promise<void> => {
    if (!recording) {
      return;
    }
    setBusy(true);
    try {
      await stageBrowserRecording(recording);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        {isRecording ? (
          <span className="flex items-center gap-1.5 text-2xs font-medium fg-destructive">
            <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-destructive" />
            Recording
          </span>
        ) : (
          <span className="text-2xs fg-secondary">
            {steps.length > 0 ? `${steps.length} steps` : 'Idle'}
          </span>
        )}
        <div className="flex-1" />
        {isRecording && (
          <Button
            variant="ghost"
            size="compact"
            onClick={(): void => {
              void handleStop();
            }}
            disabled={busy}
          >
            Stop recording
          </Button>
        )}
        <Tooltip label="Delete recording">
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            onClick={(): void => clearRecording(browserId)}
            aria-label="Delete recording"
          >
            <TrashIcon size="sm" />
          </Button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {steps.length === 0 && script.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs fg-secondary">
            No recorded actions
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {script.length > 0 && (
              <>
                <pre className="overflow-auto rounded border bg-muted/30 p-2 font-mono text-2xs">
                  <code>{script}</code>
                </pre>
                {!isRecording && (
                  <Button
                    variant="secondary"
                    size="compact"
                    className="self-start"
                    onClick={(): void => {
                      void handleAttach();
                    }}
                    disabled={busy}
                  >
                    <ChatIcon size="sm" />
                    <span>{CHAT_UNIT_LABEL}</span>
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
