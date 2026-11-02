import {
  readAutoResumeMetadata,
  readChatAutoResume,
  readToolInterruption,
} from '../transcript-metadata';

it('retains a bounded trusted provider display name and ignores an unusable one', () => {
  const metadata = {
    reason: 'usage_limit',
    resendsUserMessage: false,
    providerName: 'Codex',
  };
  expect(readAutoResumeMetadata(metadata)).toEqual(metadata);
  expect(
    readAutoResumeMetadata({ ...metadata, providerName: 'x'.repeat(101) }),
  ).not.toHaveProperty('providerName');
});

it.each([
  null,
  {},
  { reason: 'app_shutdown' },
  { reason: 'future', resendsUserMessage: false },
  {
    reason: 'app_shutdown',
    resendsUserMessage: false,
    resumesUserMessageId: 42,
  },
])('ignores incomplete or unknown automatic resume metadata %#', (value) => {
  expect(readAutoResumeMetadata(value)).toBeUndefined();
});

it('reads explicit cached provenance without inferring from text or generic automation', () => {
  const autoResume = {
    reason: 'usage_limit' as const,
    resendsUserMessage: true,
    resumesUserMessageId: 'original',
  };
  expect(
    readChatAutoResume({
      parts: [{ kind: 'prompt_source', data: { autoResume } }],
    }),
  ).toEqual(autoResume);
  expect(
    readChatAutoResume({
      parts: [
        {
          kind: 'prompt_source',
          data: { source: 'automated', text: 'Continue' },
        },
      ],
    }),
  ).toBeUndefined();
});

it.each([
  null,
  {},
  { reason: 'stopped', at: Infinity },
  { reason: 'stopped', at: -1 },
  { reason: 'future', at: 100 },
])('ignores invalid tool interruption metadata %#', (value) => {
  expect(readToolInterruption(value)).toBeUndefined();
});
