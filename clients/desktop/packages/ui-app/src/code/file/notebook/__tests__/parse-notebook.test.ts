import {
  parseNotebook,
  parseNotebookCached,
  stripAnsi,
} from '../parse-notebook';

function serialize(value: unknown): string {
  return JSON.stringify(value) ?? '';
}

describe('parseNotebook', () => {
  it('normalizes string and array sources for markdown, code, and raw cells', () => {
    const result = parseNotebook(
      serialize({
        nbformat: 4,
        metadata: { language_info: { name: 'python' } },
        cells: [
          { cell_type: 'markdown', source: ['# Title\n', 'Paragraph.'] },
          { cell_type: 'code', source: 'print("hello")', execution_count: 2 },
          { cell_type: 'raw', source: ['raw ', 'text'] },
          { cell_type: 'future_cell', source: 'ignored' },
          null,
        ],
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      notebook: {
        language: 'python',
        cells: [
          { cellType: 'markdown', source: '# Title\nParagraph.' },
          {
            cellType: 'code',
            source: 'print("hello")',
            executionCount: 2,
            outputs: [],
          },
          { cellType: 'raw', source: 'raw text' },
        ],
      },
    });
  });

  it('keeps valid image attachments on Markdown cells as data URLs', () => {
    const result = parseNotebook(
      serialize({
        nbformat: 4,
        cells: [
          {
            cell_type: 'markdown',
            source: '![plot](attachment:plot.png)',
            attachments: {
              'plot.png': { 'image/png': 'AAAA' },
              'diagram.svg': { 'image/svg+xml': ['<svg/>'] },
              'broken.png': { 'image/png': 'not base64!' },
              'page.html': { 'text/html': '<b>x</b>' },
              constructor: { 'image/jpeg': 'BBBB' },
            },
          },
          { cell_type: 'markdown', source: 'none', attachments: {} },
        ],
      }),
    );

    expect(result.status).toBe('ok');
    const cells = result.status === 'ok' ? result.notebook.cells : [];
    const [withAttachments, withoutAttachments] = cells;
    const attachments =
      withAttachments?.cellType === 'markdown'
        ? withAttachments.attachments
        : undefined;
    expect([...(attachments?.keys() ?? [])]).toEqual([
      'plot.png',
      'diagram.svg',
      'constructor',
    ]);
    expect(attachments?.get('plot.png')).toBe('data:image/png;base64,AAAA');
    expect(attachments?.get('diagram.svg')).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
    expect(attachments?.get('constructor')).toBe('data:image/jpeg;base64,BBBB');
    expect(withoutAttachments).toEqual({
      cellType: 'markdown',
      source: 'none',
    });
  });

  it('normalizes every output type and skips unknown outputs', () => {
    const result = parseNotebook(
      serialize({
        nbformat: 4,
        cells: [
          {
            cell_type: 'code',
            source: '',
            execution_count: 4.5,
            outputs: [
              {
                output_type: 'stream',
                name: 'stdout',
                text: ['\u001b[0;31mred\u001b[0m\n', 'line two'],
              },
              { output_type: 'stream', name: 'stderr', text: 'warning\n' },
              {
                output_type: 'error',
                ename: '\u001b[1;31mValueError\u001b[0m',
                evalue: '\u001b[38;5;241mBad value\u001b[0m',
                traceback: [
                  '\u001b[0;31mTraceback\u001b[0m',
                  '  File "cell.py", line 1',
                ],
              },
              {
                output_type: 'execute_result',
                execution_count: 9,
                data: {
                  'text/plain': ['answer', ' = 42'],
                  'text/html': '<b>answer</b>',
                  'application/json': { answer: 42 },
                },
              },
              {
                output_type: 'display_data',
                data: {
                  'image/png': 'iVBORw0KGgo=',
                  'application/json': { answer: 42 },
                  'text/plain': ['preview', ' text'],
                },
              },
              { output_type: 'future_output', text: 'ignored' },
              false,
            ],
          },
        ],
      }),
    );

    expect(result).toEqual({
      status: 'ok',
      notebook: {
        language: null,
        cells: [
          {
            cellType: 'code',
            source: '',
            executionCount: null,
            outputs: [
              { outputType: 'stream', name: 'stdout', text: 'red\nline two' },
              { outputType: 'stream', name: 'stderr', text: 'warning\n' },
              {
                outputType: 'error',
                ename: 'ValueError',
                evalue: 'Bad value',
                traceback: 'Traceback\n  File "cell.py", line 1',
              },
              {
                outputType: 'execute_result',
                executionCount: 9,
                data: {
                  'text/plain': 'answer = 42',
                  'text/html': '<b>answer</b>',
                },
              },
              {
                outputType: 'display_data',
                data: {
                  'image/png': 'iVBORw0KGgo=',
                  'text/plain': 'preview text',
                },
              },
            ],
          },
        ],
      },
    });
  });

  it('uses kernelspec language as a fallback and returns null without a language', () => {
    const fallback = parseNotebook(
      serialize({
        nbformat: 4,
        metadata: {
          language_info: { name: '' },
          kernelspec: { language: 'julia' },
        },
        cells: [],
      }),
    );
    const missing = parseNotebook(serialize({ nbformat: 4, cells: [] }));

    expect(fallback).toEqual({
      status: 'ok',
      notebook: { language: 'julia', cells: [] },
    });
    expect(missing).toEqual({
      status: 'ok',
      notebook: { language: null, cells: [] },
    });
  });

  it('returns invalid-json for malformed input', () => {
    expect(parseNotebook('{"nbformat":4,')).toEqual({
      status: 'failed',
      reason: 'invalid-json',
    });
  });

  it('returns unsupported-version for nbformat 3 notebooks and a missing version', () => {
    expect(
      parseNotebook(serialize({ nbformat: 3, worksheets: [{ cells: [] }] })),
    ).toEqual({ status: 'failed', reason: 'unsupported-version' });
    expect(parseNotebook(serialize({ cells: [] }))).toEqual({
      status: 'failed',
      reason: 'unsupported-version',
    });
  });

  it('returns invalid-structure for malformed v4 structures and non-object roots', () => {
    expect(parseNotebook(serialize({ nbformat: 4, cells: {} }))).toEqual({
      status: 'failed',
      reason: 'invalid-structure',
    });
    expect(parseNotebook(serialize([]))).toEqual({
      status: 'failed',
      reason: 'invalid-structure',
    });
  });
});

describe('parseNotebookCached', () => {
  it('returns the same result object for repeated input and parses different input', () => {
    const firstInput = '{"nbformat":4,"cells":[]}';
    const secondInput =
      '{"nbformat":4,"cells":[{"cell_type":"raw","source":"x"}]}';
    const first = parseNotebookCached(firstInput);
    const repeated = parseNotebookCached(firstInput);
    const different = parseNotebookCached(secondInput);

    expect(repeated).toBe(first);
    expect(different).toEqual({
      status: 'ok',
      notebook: { language: null, cells: [{ cellType: 'raw', source: 'x' }] },
    });
    expect(different).not.toBe(first);
  });
});

describe('stripAnsi', () => {
  it('removes CSI sequences and leaves plain text intact', () => {
    expect(stripAnsi('\u001b[0;31mred\u001b[38;5;241m gray\u001b[K done')).toBe(
      'red gray done',
    );
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('removes OSC sequences terminated by BEL or ESC backslash', () => {
    expect(
      stripAnsi(
        '\u001b]8;;https://example.test\u0007linked\u001b]8;;https://example.test\u001b\\ plain',
      ),
    ).toBe('linked plain');
  });

  it('drops an unterminated OSC to the end of the text', () => {
    expect(stripAnsi('kept\u001b]8;;never closed')).toBe('kept');
  });

  it('strips adversarial unterminated escapes in linear time', () => {
    const hostile = 'x\u001b]'.repeat(20_000) + '\u001b[' + '1'.repeat(50_000);
    const startedAt = performance.now();
    const stripped = stripAnsi(hostile);
    const elapsed = performance.now() - startedAt;

    expect(stripped).toBe('x');
    expect(elapsed).toBeLessThan(200);
  });
});
