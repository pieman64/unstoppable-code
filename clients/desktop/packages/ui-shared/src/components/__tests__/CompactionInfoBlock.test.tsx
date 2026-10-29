import { renderToString } from 'react-dom/server';
import { CompactionInfoBlock } from '../chat/CompactionInfoBlock';

describe('CompactionInfoBlock', () => {
  const timestamp = Date.UTC(2026, 8, 9, 10, 11, 0);
  const localTime = new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  it('renders the headline, the local time, and the summary', () => {
    const html = renderToString(
      <CompactionInfoBlock
        headline="Claude compacted this session"
        timestamp={timestamp}
        summary="Kept the plan and the last three tool results."
      />,
    );
    expect(html).toContain('data-testid="compaction-info-block"');
    expect(html).toContain('Claude compacted this session');
    expect(html).toContain(localTime);
    expect(html).toContain('Kept the plan and the last three tool results.');
  });

  it('omits the summary row when the provider sent none', () => {
    const html = renderToString(
      <CompactionInfoBlock
        headline="Claude compacted this session"
        timestamp={timestamp}
      />,
    );
    expect(html).not.toContain('pl-6');
  });
});
