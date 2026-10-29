/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { RawYamlView } from '../RawYamlView';
import { rootClassList } from '@/test-utils/replay';

describe('RawYamlView', () => {
  it.each([
    ['without a parse error', null],
    ['with a parse error', 'bad indentation at line 3'],
  ])(
    'blocks the YAML editor root from session replay %s',
    (_label, error): void => {
      const markup = renderToStaticMarkup(
        <RawYamlView
          value={'name: Deploy\nsteps:\n  - run: ./deploy.sh'}
          onChange={jest.fn()}
          error={error}
          readonly={false}
        />,
      );

      // The YAML and its parse error, which can quote it, sit in one root,
      // so the block leads and the rest stay as they were.
      expect(rootClassList(markup)).toEqual([
        POSTHOG_REPLAY_BLOCK_CLASS,
        'flex-1',
        'flex',
        'flex-col',
        'overflow-hidden',
      ]);
    },
  );
});
