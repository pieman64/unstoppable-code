import { PORTAL_PIPELINE_CONTENT_PAGE_MAX_CHARS } from '@canopy/protocol/portal';
import {
  agentTranscriptDocument,
  pipelineContentPage,
  plainLogDocument,
  reportDocument,
} from '../pipeline-content';

const claudeLine = (value: unknown): string => JSON.stringify(value);

const transcript = [
  claudeLine({ type: 'system', subtype: 'init', session_id: 's-1' }),
  claudeLine({
    type: 'assistant',
    uuid: 'a-1',
    message: {
      id: 'm-1',
      role: 'assistant',
      content: [{ type: 'text', text: '## Plan\n\n- read the code' }],
    },
  }),
  claudeLine({
    type: 'assistant',
    uuid: 'a-2',
    message: {
      id: 'm-2',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'ls' },
        },
      ],
    },
  }),
  claudeLine({
    type: 'user',
    uuid: 'u-1',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'secret.txt' },
      ],
    },
  }),
  claudeLine({
    type: 'assistant',
    uuid: 'a-3',
    message: {
      id: 'm-3',
      role: 'assistant',
      content: [{ type: 'text', text: 'All **done**.' }],
    },
  }),
  claudeLine({ type: 'result', subtype: 'success', result: 'All done.' }),
].join('\n');

describe('agentTranscriptDocument', () => {
  it('keeps only the assistant text, in order, without provider envelopes', () => {
    const document = agentTranscriptDocument(transcript, 'claude');
    expect(document).toEqual({
      format: 'markdown',
      text: '## Plan\n\n- read the code\n\nAll **done**.',
    });
    expect(document?.text).not.toContain('{');
    expect(document?.text).not.toContain('secret.txt');
  });

  it('reads persisted Ollama prompt and Claude-format assistant events', () => {
    const persisted = [
      claudeLine({
        type: 'canopy_user_prompt',
        original_text: 'Review this change',
        user_message_id: 'prompt-1',
      }),
      transcript,
    ].join('\n');
    expect(agentTranscriptDocument(persisted, 'ollama')).toEqual({
      format: 'markdown',
      text: '## Plan\n\n- read the code\n\nAll **done**.',
    });
  });

  it('returns null for a plain log so it stays a plain log', () => {
    expect(agentTranscriptDocument('npm test\nok 3 tests', 'claude')).toBe(
      null,
    );
  });
});

describe('plainLogDocument', () => {
  it('keeps command output verbatim apart from terminal colors and CRLF', () => {
    expect(
      plainLogDocument('\u001b[32mPASS\u001b[0m a.test.ts\r\n  {"x": 1}\r\n'),
    ).toEqual({ format: 'text', text: 'PASS a.test.ts\n  {"x": 1}\n' });
  });
});

describe('reportDocument', () => {
  it('shows a Markdown report, then the indented JSON report', () => {
    expect(
      reportDocument({
        text: { content: '# Report\n\nOK', markdown: true },
        json: '{"ok":true}',
      }).text,
    ).toBe(
      '# Report\n\nOK\n\n## JSON report\n\n```json\n{\n  "ok": true\n}\n```',
    );
  });

  it('fences a plain-text report, longer than any fence inside it', () => {
    expect(
      reportDocument({
        text: { content: 'a\n```\nb\n', markdown: false },
      }).text,
    ).toBe('````text\na\n```\nb\n````');
  });

  it('is empty without a saved report', () => {
    expect(reportDocument({})).toEqual({ format: 'markdown', text: '' });
  });
});

describe('pipelineContentPage', () => {
  it('pages a long document so its beginning, middle and end all arrive', () => {
    const text = `start${'x'.repeat(PORTAL_PIPELINE_CONTENT_PAGE_MAX_CHARS * 2)}end`;
    const document = { format: 'text' as const, text };
    let offset = 0;
    let joined = '';
    let pages = 0;
    for (;;) {
      const page = pipelineContentPage(document, offset, 'r');
      if (!page) throw new Error('page missing');
      expect(page.content.length).toBeLessThanOrEqual(
        PORTAL_PIPELINE_CONTENT_PAGE_MAX_CHARS,
      );
      joined += page.content;
      pages += 1;
      if (page.nextOffset === page.length) break;
      offset = page.nextOffset;
    }
    expect(pages).toBe(3);
    expect(joined).toBe(text);
  });

  it('never splits a surrogate pair across pages', () => {
    const text = `${'a'.repeat(PORTAL_PIPELINE_CONTENT_PAGE_MAX_CHARS - 1)}😀b`;
    const first = pipelineContentPage({ format: 'text', text }, 0, 'r');
    expect(first?.nextOffset).toBe(PORTAL_PIPELINE_CONTENT_PAGE_MAX_CHARS - 1);
    expect(
      pipelineContentPage({ format: 'text', text }, first?.nextOffset ?? 0, 'r')
        ?.content,
    ).toBe('😀b');
  });

  it('rejects an offset outside the document or inside a pair', () => {
    const document = { format: 'text' as const, text: 'a😀' };
    expect(pipelineContentPage(document, 4, 'r')).toBeNull();
    expect(pipelineContentPage(document, 2, 'r')).toBeNull();
    expect(pipelineContentPage(document, -1, 'r')).toBeNull();
    expect(pipelineContentPage(document, 3, 'r')).toMatchObject({
      content: '',
      nextOffset: 3,
      length: 3,
    });
  });
});
