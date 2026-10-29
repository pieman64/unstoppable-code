import { renderToString } from 'react-dom/server';
import {
  parseSubagentReference,
  withSubagentReference,
  type SubagentReference,
} from '@canopy/agent-transcript';
import { SubagentReferenceAttachment } from '../SubagentReferenceAttachment';
import { SubagentReferenceChip } from '../SubagentReferenceChip';
import { splitSubagentReference } from '../split-subagent-reference';

const reference: SubagentReference = {
  kind: 'managed',
  id: 'subagent-1',
  title: 'Plan the migration',
};

describe('splitSubagentReference', () => {
  it('splits a message encoded with withSubagentReference', () => {
    const text = withSubagentReference(reference, 'Please review the plan.');

    expect(splitSubagentReference(text)).toEqual({
      reference: parseSubagentReference(text)?.reference,
      body: 'Please review the plan.',
    });
  });

  it.each([
    'Ordinary message text',
    'Ordinary message text\nwith multiple lines',
    'About Plan [canopy-subagent:unknown:id]\n\nMessage body',
    'About Plan [canopy-subagent:managed:id]',
  ])('returns unrecognized message text unchanged: %p', (text) => {
    const split = splitSubagentReference(text);
    expect(split).toEqual({ reference: null, body: text });
    expect(split.body).toBe(text);
  });
});

describe('SubagentReferenceChip', () => {
  it('renders the title, accessible name and robot icon', () => {
    const html = renderToString(
      <SubagentReferenceChip title={reference.title} />,
    );

    expect(html).toContain('data-testid="subagent-reference-chip"');
    expect(html).toContain('class="sr-only">About');
    expect(html).toContain('Plan the migration');
    expect(html).toContain('<svg');
    expect(html).toContain('aria-hidden="true"');
  });

  it('uses the untitled fallback for an empty title', () => {
    const html = renderToString(<SubagentReferenceChip title="" />);

    expect(html).toContain('class="sr-only">About');
    expect(html).toContain('>Subagent</span>');
  });
});

it('places the attachment in a plain right-aligned row', () => {
  const html = renderToString(
    <SubagentReferenceAttachment title={reference.title} />,
  );

  expect(html).toContain('class="mb-1 flex justify-end"');
  expect(html).toContain('data-testid="subagent-reference-chip"');
});
