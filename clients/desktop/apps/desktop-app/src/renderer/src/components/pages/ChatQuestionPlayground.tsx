import { useEffect, useState, type JSX } from 'react';
import { ChatContent } from '../chat/ChatContent';
import { Button, Disclosure, Heading } from '@canopy/ui-shared/components';
import { toActiveComposerView, toActiveTranscriptView } from '../chat/types';
import { ChatSurfaceProvider } from '@/stores/chat/surface-store';
import { createQuestionSandbox } from './chatQuestionSandbox';
import { QUESTION_PRESETS } from './chatQuestionPlaygroundData';

export function ChatQuestionPlayground(): JSX.Element {
  const [sandbox] = useState(createQuestionSandbox);
  const machine = sandbox.machine();
  const dispatch = sandbox.dispatch;
  const tab = sandbox.store((s) => Object.values(s.worktreeChats)[0].tabs[0]);
  useEffect(() => (): void => sandbox.dispose(), [sandbox]);
  const [compact, setCompact] = useState(false);
  const [turnRunning, setTurnRunning] = useState(false);
  const preset =
    QUESTION_PRESETS.find((p) => p.id === machine.presetId) ??
    QUESTION_PRESETS[0];
  const inFlight =
    machine.phase === 'submitting' || machine.phase === 'dismissing';
  const terminal =
    machine.phase === 'answered' || machine.phase === 'dismissed';
  const phases = ['pending', 'submitting', 'answered'] as const;
  const safeAnswers = machine.answers.map((answer, index) =>
    preset.questions[index]?.secret
      ? {
          ...answer,
          selectedOptions: answer.selectedOptions.map(() => '[hidden]'),
          ...(answer.freeformText ? { freeformText: '[hidden]' } : {}),
        }
      : answer,
  );

  const startConversation = (id: string): void =>
    dispatch({ type: 'preset', id });

  return (
    <div
      data-testid="chat-question-playground"
      data-state={machine.phase}
      className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_280px] overflow-hidden rounded-xl border border-line-base bg-base"
    >
      <section
        data-testid="playground-chat"
        className={`flex h-full min-h-0 min-w-0 flex-col ${compact ? 'mx-auto w-full max-w-97.5' : ''}`}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-line-base px-4">
          <span className="text-xs font-medium fg-primary">{preset.title}</span>
          <span className="text-xs fg-secondary">
            {inFlight ? 'Waiting for response' : 'Chat'}
          </span>
        </header>
        <ChatSurfaceProvider
          scope={{
            store: sandbox.store,
            mode: 'sandbox',
            disconnected: machine.phase === 'disconnected',
          }}
        >
          <ChatContent
            transcript={toActiveTranscriptView(tab)}
            composerTab={toActiveComposerView(tab)}
            onClearQueuedMessage={() => undefined}
            onSendMessage={sandbox.sendMessage}
            hideBranchActions
            hideDirectoryPicker
            disableTerminalMode
            disableFileTypeahead
          />
        </ChatSurfaceProvider>
      </section>
      <aside
        aria-label="Playground controls"
        className="min-h-0 space-y-5 overflow-y-auto border-l border-line-base bg-base p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <Heading level={2} variant="title">
            Playground controls
          </Heading>
          <Button
            variant="outline"
            aria-pressed={compact}
            onClick={() => setCompact(!compact)}
          >
            Compact width
          </Button>
        </div>
        <Button
          variant="outline"
          aria-pressed={turnRunning}
          data-testid="playground-turn-running"
          onClick={() => {
            sandbox.setTurnRunning(!turnRunning);
            setTurnRunning(!turnRunning);
          }}
        >
          Turn still running
        </Button>
        <div>
          <Heading level={3} variant="label" className="mb-2">
            Trigger a question
          </Heading>
          <div className="space-y-1">
            {QUESTION_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={item.title}
                aria-pressed={item.id === preset.id}
                onClick={() => startConversation(item.id)}
                className={`focus-ring w-full rounded-lg px-3 py-2.5 text-left text-s ${item.id === preset.id ? 'bg-selected fg-primary' : 'fg-secondary hover:bg-secondary'}`}
              >
                {item.title}
              </button>
            ))}
          </div>
        </div>
        <section
          className="border-t border-line-base pt-5"
          aria-label="Question state machine"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Heading level={2} variant="title">
                State machine
              </Heading>
              <p className="mt-1 text-xs fg-secondary">
                Submit or dismiss in the chat, then resolve or fail the request
                here.
              </p>
            </div>
            <span
              role="status"
              className={`text-s ${machine.phase === 'error' ? 'fg-destructive-strong' : terminal ? 'fg-success-strong' : 'fg-secondary'}`}
            >
              {machine.phase}
            </span>
          </div>
          <div
            className="my-4 flex flex-wrap items-center gap-4"
            aria-label="Submission path"
          >
            {phases.map((phase) => (
              <span
                key={phase}
                className={`border-b pb-1 text-xs ${machine.phase === phase ? 'border-line-primary fg-primary' : 'border-transparent fg-tertiary'}`}
              >
                {phase}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!inFlight}
              onClick={() => dispatch({ type: 'resolve' })}
            >
              Resolve request
            </Button>
            <Button
              variant="outline"
              disabled={!inFlight}
              onClick={() => dispatch({ type: 'fail' })}
            >
              Fail request
            </Button>
            <Button
              variant="outline"
              disabled={inFlight || terminal}
              onClick={() =>
                dispatch({
                  type:
                    machine.phase === 'disconnected'
                      ? 'reconnect'
                      : 'disconnect',
                })
              }
            >
              {machine.phase === 'disconnected' ? 'Reconnect' : 'Disconnect'}
            </Button>
            <Button
              variant="outline"
              onClick={() => startConversation(preset.id)}
            >
              Start again
            </Button>
          </div>
          <div className="mt-5 grid gap-4 border-t border-line-base pt-4 grid-cols-1">
            <div>
              <Heading level={3} variant="label">
                Event history
              </Heading>
              <ol className="mt-2 space-y-1 text-xs fg-primary">
                {machine.events.map((event, index) => (
                  <li key={`${index}-${event}`}>
                    <span className="mr-2 tabular-nums fg-secondary">
                      {index + 1}.
                    </span>
                    {event}
                  </li>
                ))}
              </ol>
            </div>
            <Disclosure label="Response payload">
              <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-secondary p-3 text-xs fg-primary">
                {JSON.stringify(safeAnswers, null, 2)}
              </pre>
            </Disclosure>
          </div>
        </section>
        <p className="text-xs leading-relaxed fg-secondary">
          Local simulation. No messages are sent and no agents are started.
        </p>
      </aside>
    </div>
  );
}
