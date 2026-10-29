import { renderToString } from 'react-dom/server';
import { TestSettingsHost } from '../../__tests__/helpers/test-settings-host';
import { EntityGraphView } from '../EntityGraphView';

describe('EntityGraphView app-shell sizing', () => {
  it('sizes against the containing app scroll region, not the viewport', () => {
    const html = renderToString(
      <TestSettingsHost>
        <EntityGraphView orgId="org-1" />
      </TestSettingsHost>,
    );

    expect(html).toContain('100cqh');
    expect(html).not.toContain('100dvh');
  });
});
