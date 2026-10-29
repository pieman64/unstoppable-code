import { renderToString } from 'react-dom/server';
import { MessageAttachments } from '../MessageAttachments';

it('renders desktop message files through the shared compact chip surface', () => {
  const out = renderToString(
    <MessageAttachments
      attachmentPaths={['/workspace/notes.txt', '/workspace/transactions.csv']}
    />,
  );

  expect(out.match(/data-testid="file-attachment-chip"/g) ?? []).toHaveLength(
    2,
  );
  expect(out).toContain('notes.txt');
  expect(out).toContain('transactions.csv');
  expect(out).not.toContain('data-testid="file-deliverable-card"');
});
