'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  Button,
  ProviderStatusDot,
  StatusLabel,
  TextInput,
} from '@canopy/ui-shared/components';

export type AiGatewayKeyState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'unavailable' }
  | { kind: 'stored'; suffix: string; failed: boolean };

/** The host supplies sanitized state and the existing secure credential writer. */
export function AiGatewayConnectionSlot({
  state,
  label = 'API key',
  save,
  replayBlock,
}: {
  readonly state: AiGatewayKeyState;
  readonly label?: string;
  readonly save: (key: string) => Promise<string | null>;
  readonly replayBlock: string;
}): JSX.Element {
  const [changing, setChanging] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const generationRef = useRef(0);
  useEffect(
    () => (): void => {
      generationRef.current += 1;
    },
    [],
  );

  const submit = async (): Promise<void> => {
    const secret = key.trim();
    if (submittingRef.current || !secret) return;
    submittingRef.current = true;
    const generation = generationRef.current;
    setBusy(true);
    setError(null);
    try {
      const failure = await save(secret);
      if (generation !== generationRef.current) return;
      setError(failure);
      if (failure === null) {
        setKey('');
        setChanging(false);
      }
    } finally {
      submittingRef.current = false;
      if (generation === generationRef.current) setBusy(false);
    }
  };
  const editing = changing || state.kind === 'missing';
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <div className={`min-w-0 flex-1 ${replayBlock}`}>
              <TextInput
                density="settings"
                mono
                type="password"
                aria-label={label}
                autoComplete="off"
                value={key}
                disabled={busy || state.kind === 'unavailable'}
                data-testid="ai-gateway-change-key-input"
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                  if (event.key === 'Escape' && !busy) {
                    setKey('');
                    setChanging(false);
                  }
                }}
              />
            </div>
            <Button
              type="button"
              variant="primary"
              size="compact"
              disabled={busy || !key.trim()}
              data-testid="ai-gateway-change-key-save"
              onClick={() => void submit()}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        ) : (
          <>
            <span
              className="flex min-w-0 flex-1 items-center gap-2 text-xs fg-secondary"
              role="status"
            >
              {state.kind === 'loading' ? (
                'Checking…'
              ) : state.kind === 'unavailable' ? (
                "Secure storage isn't available."
              ) : (
                <>
                  <ProviderStatusDot
                    tone={state.failed ? 'failed' : 'connected'}
                    label={state.failed ? 'Key rejected' : 'Connected'}
                  />
                  <span className={`font-mono ${replayBlock}`}>
                    {state.suffix}
                  </span>
                </>
              )}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="compact"
              disabled={
                state.kind === 'loading' || state.kind === 'unavailable'
              }
              data-testid="ai-gateway-change-key"
              onClick={() => setChanging(true)}
            >
              Change key
            </Button>
          </>
        )}
      </div>
      {error ? (
        <StatusLabel
          tone="destructive"
          size="xs"
          data-testid="ai-gateway-key-notice"
        >
          {error}
        </StatusLabel>
      ) : null}
    </div>
  );
}
