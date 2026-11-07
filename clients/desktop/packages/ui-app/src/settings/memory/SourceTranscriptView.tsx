'use client';

import { useEffect, useMemo, useRef, type JSX } from 'react';
import { Markdown } from '@canopy/ui-shared/components/Markdown';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import type { ExplorerSourceTranscript } from '@canopy/protocol/settings/organization-memory';
import { withPrivacyClass } from '../account/privacy-class';
import { useSettingsPrivacy } from '../host';
import {
  useMemorySettingsSlots,
  type MemoryTranscriptMessageProps,
} from './memory-settings-slots';
import { Heading } from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

interface SourceTranscriptViewProps {
  transcript: ExplorerSourceTranscript;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The slot-less transcript message: its text as Markdown. */
function MarkdownTranscriptMessage({
  message,
}: MemoryTranscriptMessageProps): JSX.Element {
  return (
    <div className="prose prose-sm max-w-none break-words fg-primary dark:prose-invert">
      <p className="text-xs font-medium fg-secondary">
        {capitalizeFirstLetter(message.role)}
      </p>
      <Markdown>{message.content}</Markdown>
    </div>
  );
}

export function SourceTranscriptView({
  transcript,
}: SourceTranscriptViewProps): JSX.Element {
  const { blockClassName } = useSettingsPrivacy();
  const { TranscriptMessage = MarkdownTranscriptMessage } =
    useMemorySettingsSlots();
  const targetRef = useRef<HTMLDivElement>(null);
  const targetMessageId = useMemo(() => {
    const needle = normalize(transcript.evidenceQuote ?? '');
    if (needle.length === 0) {
      return null;
    }
    return (
      transcript.messages.find((message) =>
        normalize(message.content).includes(needle),
      )?.localMessageId ?? null
    );
  }, [transcript.evidenceQuote, transcript.messages]);

  useEffect(() => {
    targetRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, [targetMessageId]);

  if (transcript.restricted) {
    return (
      <Surface as="section" variant="card">
        <div className="p-5">
          <Heading level={2} variant="section">
            Private source transcript
          </Heading>
          <p className="mt-2 text-s leading-6 fg-secondary">
            This source is privately owned. Organization administrators can see
            the extracted evidence and source metadata, but not the private
            transcript.
          </p>
          {transcript.evidenceQuote !== null && (
            <blockquote
              className={withPrivacyClass(
                'mt-4 rounded-lg border-l-2 border-line-accent bg-accent/5 px-4 py-3 text-s italic fg-secondary',
                blockClassName,
              )}
            >
              “{transcript.evidenceQuote}”
            </blockquote>
          )}
        </div>
      </Surface>
    );
  }

  return (
    <Surface as="section" variant="card">
      <div className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <Heading level={2} variant="section">
              Source transcript
            </Heading>
            <p
              className={withPrivacyClass(
                'mt-1 text-xs fg-secondary',
                blockClassName,
              )}
            >
              {transcript.source.actor?.name ??
                transcript.source.actor?.email ??
                'Unknown actor'}{' '}
              · {new Date(transcript.source.referenceTime).toLocaleString()}
            </p>
          </div>
        </div>
        {transcript.messages.length === 0 ? (
          <p className="py-12 text-center text-s fg-secondary">
            The transcript could not be decrypted or parsed.
          </p>
        ) : (
          <div className={withPrivacyClass('mt-5 space-y-3', blockClassName)}>
            {transcript.messages.map((message) => {
              const highlighted = message.localMessageId === targetMessageId;
              return (
                <div
                  key={message.localMessageId}
                  ref={highlighted ? targetRef : undefined}
                  className={
                    highlighted
                      ? 'rounded-lg border border-line-accent bg-accent/5 p-3'
                      : 'rounded-lg p-3'
                  }
                >
                  {highlighted && transcript.evidenceQuote !== null && (
                    <mark className="mb-3 block rounded bg-warning-subtle px-2 py-1 text-xs fg-primary">
                      Evidence match: “{transcript.evidenceQuote}”
                    </mark>
                  )}
                  <TranscriptMessage message={message} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Surface>
  );
}
