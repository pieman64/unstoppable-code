/** @jest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ShellCommandContent } from '../PipelineStepDetailParts';

function blocked(host: HTMLElement, text: string): boolean {
  const node = Array.from(host.querySelectorAll('*')).find(
    (element) =>
      element.childElementCount === 0 && element.textContent === text,
  );
  if (!node) throw new Error(`${text} not rendered`);
  return node.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) !== null;
}

describe('ShellCommandContent session replay', () => {
  it('blocks an interpolated pipeline command and records the shell', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <ShellCommandContent
        step={{
          id: 'deploy',
          run: 'curl -H "Authorization: Bearer ${{ secrets.TOKEN }}" api',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 10,
          skip_on_missing_action: false,
        }}
        stepResult={{
          status: 'success',
          outputs: {},
          dynamic_env: {},
          resolved_run: 'curl -H "Authorization: Bearer secret" api',
        }}
      />,
    );
    expect(blocked(host, 'curl -H "Authorization: Bearer secret" api')).toBe(
      true,
    );
    expect(blocked(host, 'bash')).toBe(false);
  });
});
