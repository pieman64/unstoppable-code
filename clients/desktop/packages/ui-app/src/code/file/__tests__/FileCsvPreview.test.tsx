import { renderToString } from 'react-dom/server';
import {
  buildCsvTableModel,
  FileCsvPreview,
  parseCsvTableContent,
} from '../FileCsvPreview';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

function rootClassList(markup: string): string[] {
  const match = /^<[a-z]+\b[^>]*?\sclass="([^"]*)"/.exec(markup);
  return match?.[1]?.split(' ') ?? [];
}

describe('parseCsvTableContent', () => {
  it('handles quoted commas and escaped quotes', () => {
    expect(parseCsvTableContent('name,note\nalpha,"one, ""two"""')).toEqual({
      rows: [
        ['name', 'note'],
        ['alpha', 'one, "two"'],
      ],
      error: null,
    });
  });

  it('reports inconsistent record lengths', () => {
    expect(parseCsvTableContent('a,b\n1').error).toContain(
      'Invalid Record Length',
    );
  });
});

describe('buildCsvTableModel', () => {
  it('recognizes a label header and preserves headerless numeric rows', () => {
    expect(
      buildCsvTableModel([
        ['name', 'count'],
        ['alpha', '2'],
      ]),
    ).toEqual({
      header: ['name', 'count'],
      rows: [['alpha', '2']],
    });
    expect(
      buildCsvTableModel([
        ['1', '2'],
        ['3', '4'],
      ]).header,
    ).toBeNull();
  });
});

describe('FileCsvPreview', () => {
  function render(content: string): string {
    return renderToString(<FileCsvPreview content={content} />);
  }

  it('renders parsed rows as a table', () => {
    const output = render('name,count\nalpha,2');
    expect(output).toContain('file-viewer-csv-table-scroll');
    expect(output).toContain('<th');
    expect(output).toContain('alpha');
  });

  it('blocks the table root from session replay', () => {
    expect(
      rootClassList(renderToString(<FileCsvPreview content={'a,b\n1,2'} />)),
    ).toEqual([REPLAY_BLOCK_CLASS, 'min-h-0', 'flex-1', 'overflow-auto']);
  });

  it('blocks the raw-text fallback body and records the parse notice', () => {
    const markup = renderToString(<FileCsvPreview content={'a,b\n1'} />);
    expect(rootClassList(markup)).toEqual([
      'flex',
      'min-h-0',
      'flex-1',
      'flex-col',
    ]);
    expect(markup).toMatch(
      new RegExp(
        `<pre[^>]*data-testid="file-viewer-csv-raw-scroll"[^>]*class="${REPLAY_BLOCK_CLASS} `,
      ),
    );
  });

  it('renders raw text with an explanation when parsing fails', () => {
    const output = render('a,b\n1');
    expect(output).toContain('file-viewer-csv-raw-scroll');
    expect(output).toContain('Could not parse as CSV');
  });

  it('falls back to raw text before an excessive row count can be rendered', () => {
    const content = Array.from(
      { length: 10_001 },
      (_, index) => `${index},value`,
    ).join('\n');

    const output = render(content);

    expect(output).toContain('file-viewer-csv-raw-scroll');
    expect(output).toContain('CSV table limit exceeded');
    expect(output).not.toContain('file-viewer-csv-table-scroll');
  });

  it('falls back to raw text before an excessive cell count can be rendered', () => {
    const row = Array.from({ length: 101 }, (_, index) => `${index}`).join(',');
    const content = Array.from({ length: 991 }, () => row).join('\n');

    const output = render(content);

    expect(output).toContain('file-viewer-csv-raw-scroll');
    expect(output).toContain('CSV table limit exceeded');
    expect(output).not.toContain('file-viewer-csv-table-scroll');
  });
});
