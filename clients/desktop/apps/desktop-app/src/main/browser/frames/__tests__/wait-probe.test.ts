import type { ActionTargetDeps } from '../action-targets';
import { ExecutionContexts } from '../execution-contexts';
import { HOST_WORLD_NAME } from '../host-cdp';
import { LocatorRequestError } from '../locator-requests';
import type { BrowserPageModel } from '../model-types';
import { buildPageModel } from '../page-model';
import { probeMatches, readTopReadyState } from '../wait-probe';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
} from './fixtures/recorded-cdp';

/** The pattern BrowserService maps to an invalid wait target. */
const INVALID_TARGET =
  /invalid (?:css )?(?:locator|selector)|selector syntax|syntaxerror|failed to parse selector|unsupported (?:playwright[- ]like )?(?:locator|selector)|(?:locator|selector).*unsupported/i;

async function setup(
  name: string,
  extra: ActionTargetDeps['send'] = () => Promise.reject(new Error('x')),
): Promise<{ deps: ActionTargetDeps; model: BrowserPageModel }> {
  const recording = loadRecording(name);
  const replay = recordedSend(recording);
  const replayDeps = recordedDeps(recording);
  return {
    model: await buildPageModel(replayDeps),
    deps: {
      registry: replayDeps.registry,
      contexts: new ExecutionContexts(),
      send: (method, params, sessionId) =>
        method === 'DOM.querySelectorAll' &&
        typeof params.selector === 'string' &&
        params.selector.startsWith('[[')
          ? Promise.reject(new Error('DOM Error while querying'))
          : method.startsWith('DOM.querySelector')
            ? replay(method, params, sessionId)
            : extra(method, params, sessionId),
    },
  };
}

describe('wait_for probe on the model', () => {
  it('counts matches and visible matches in every frame', async () => {
    const { deps, model } = await setup('frames');
    expect(
      await probeMatches(deps, model, { locator: "page.locator('button')" }),
    ).toEqual({ matchCount: 4, visibleCount: 4 });
    expect(await probeMatches(deps, model, { text: 'Frame action' })).toEqual({
      matchCount: 1,
      visibleCount: 1,
    });
    expect(await probeMatches(deps, model, { text: '' })).toEqual({
      matchCount: 0,
      visibleCount: 0,
    });
  });

  it('counts visibility with the preload rule: a box, not display none, not hidden', async () => {
    const { deps, model } = await setup('hidden');
    // Visible again and Transparent (opacity does not count) are visible;
    // a display: contents element and a display: none button are not.
    expect(
      await probeMatches(deps, model, { locator: "getByRole('button')" }),
    ).toEqual({ matchCount: 4, visibleCount: 2 });
    expect(await probeMatches(deps, model, { text: 'Hidden tab' })).toEqual({
      matchCount: 1,
      visibleCount: 0,
    });
  });

  it('rejects invalid CSS and unsupported locators with an invalid-target error', async () => {
    const { deps, model } = await setup('frames');
    for (const locator of ["page.locator('[[')", "page.getByTitle('x')"]) {
      const failure = await probeMatches(deps, model, { locator }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(LocatorRequestError);
      expect(failure instanceof Error ? failure.message : '').toMatch(
        INVALID_TARGET,
      );
    }
  });
});

describe('the top document ready state', () => {
  it('reads document.readyState in the top frame host world', async () => {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const { deps, model } = await setup('frames', (method, params) => {
      sent.push({ method, params });
      if (method === 'Page.createIsolatedWorld')
        return Promise.resolve({ executionContextId: 91 });
      if (method === 'Runtime.evaluate')
        return Promise.resolve({
          result: { type: 'string', value: 'interactive' },
        });
      return Promise.reject(new Error('Unexpected'));
    });
    expect(await readTopReadyState(deps)).toBe('interactive');
    expect(sent).toEqual([
      {
        method: 'Page.createIsolatedWorld',
        params: {
          frameId: model.frames[0]?.frameId,
          worldName: HOST_WORLD_NAME,
        },
      },
      {
        method: 'Runtime.evaluate',
        params: {
          expression: 'document.readyState',
          contextId: 91,
          returnByValue: true,
        },
      },
    ]);
  });

  it('fails when the top document cannot be read or answers garbage', async () => {
    const garbage = await setup('frames', (method) =>
      method === 'Page.createIsolatedWorld'
        ? Promise.resolve({ executionContextId: 91 })
        : Promise.resolve({ result: { type: 'string', value: 'ready' } }),
    );
    await expect(readTopReadyState(garbage.deps)).rejects.toThrow();
    const gone = await setup('frames');
    await expect(readTopReadyState(gone.deps)).rejects.toThrow();
  });
});
