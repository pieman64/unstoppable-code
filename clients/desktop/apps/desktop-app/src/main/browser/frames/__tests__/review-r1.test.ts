/**
 * @jest-environment jsdom
 */
/**
 * Review R1 of 16e0d14fde (.mini-swarm/phase04b/review-R1.md), cases kept
 * as the reviewer wrote them. The closed-root focus case is in
 * focused-target.test.ts, with the CDP calls the fix makes.
 */
import { buildPageModel } from '../page-model';
import {
  loadRecording,
  recordedDeps,
  recordedHtml,
} from './fixtures/recorded-cdp';
import {
  cloneRecording,
  treeRoot,
  findTreeNode,
  appendChild,
  elementRecord,
  textRecord,
} from './fixtures/recording-edit';
import { matchLocator } from '../locator-requests';
import { resolveLocatorTarget } from '../action-targets';
import { ExecutionContexts } from '../execution-contexts';
import type { ActionTargetDeps } from '../action-targets';
import { probeMatches } from '../wait-probe';

// jsdom lacks structuredClone; these fixture records contain JSON only.
beforeAll(() => {
  Reflect.set(globalThis, 'structuredClone', (value: unknown): unknown => {
    const copy: unknown = JSON.parse(JSON.stringify(value));
    return copy;
  });
});

describe('adversarial review: target and wait parity', () => {
  it('must reject cross-frame label matches as ambiguous rather than select the first frame', async () => {
    const recording = cloneRecording(loadRecording('frames'));
    const root = treeRoot(recording);
    const body = findTreeNode(root, (n) => n.nodeName === 'BODY');
    appendChild(
      body,
      elementRecord(99001, 'label', { for: 'before' }, [
        textRecord(99002, 'Name'),
      ]),
    );
    const replay = recordedDeps(recording, {
      controlHistory: (_f, _s, _scope, ids) =>
        Promise.resolve(ids.map(() => 'never')),
    });
    const model = await buildPageModel(replay);
    const send: ActionTargetDeps['send'] = (method, params, session) => {
      if (method === 'DOM.resolveNode')
        return Promise.resolve({
          object: { objectId: `node-${String(params.backendNodeId)}` },
        });
      if (method === 'Runtime.callFunctionOn')
        return Promise.resolve({ result: { value: true } });
      return replay.send(method, params, session);
    };
    const deps = {
      send,
      registry: replay.registry,
      contexts: new ExecutionContexts(),
    };
    const all = await matchLocator(
      model,
      deps,
      "page.getByLabel('Name')",
      model.frames,
      'wait',
    );
    expect(new Set(all.map((n) => n.frameId)).size).toBe(2);
    expect(
      await resolveLocatorTarget(deps, model, "page.getByLabel('Name')"),
    ).toMatchObject({ status: 'target_ambiguous' });
  });

  it('must include an existing secret-select option in CSS wait counts', async () => {
    const recording = loadRecording('secrets');
    const replay = recordedDeps(recording);
    const model = await buildPageModel(replay);
    const option = model.nodes.find(
      (n) => n.tagName === 'option' && n.insideSecretSelect,
    );
    if (!option) throw new Error('No secret option');
    document.body.innerHTML = recordedHtml('secrets');
    expect(document.querySelectorAll('#expiry > option')).toHaveLength(1);
    const deps = {
      registry: replay.registry,
      contexts: new ExecutionContexts(),
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ): Promise<unknown> =>
        method === 'DOM.querySelectorAll'
          ? Promise.resolve({ nodeIds: [option.nodeId] })
          : replay.send(method, params, session),
    };
    expect(
      await probeMatches(deps, model, { locator: 'css=#expiry > option' }),
    ).toMatchObject({ matchCount: 1 });
  });

  it('must reject invalid CSS inside a frame locator in wait mode', async () => {
    const recording = loadRecording('frames');
    const replay = recordedDeps(recording);
    const model = await buildPageModel(replay);
    const owner = model.nodes.find((n) => n.attributes.id === 'framed');
    if (!owner) throw new Error('No frame owner');
    const deps = {
      registry: replay.registry,
      contexts: new ExecutionContexts(),
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ): Promise<unknown> => {
        if (method === 'DOM.querySelectorAll') {
          if (params.selector === '#framed')
            return Promise.resolve({ nodeIds: [owner.nodeId] });
          if (params.selector === '[[')
            return Promise.reject(new Error('DOM Error while querying'));
        }
        return replay.send(method, params, session);
      },
    };
    await expect(
      probeMatches(deps, model, {
        locator: "page.frameLocator('#framed').locator('[[')",
      }),
    ).rejects.toThrow(/Invalid CSS locator/);
  });

  it('must preserve literal query whitespace as the preload text probe does', async () => {
    const recording = loadRecording('hidden');
    const replay = recordedDeps(recording);
    const model = await buildPageModel(replay);
    const deps = {
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ): Promise<unknown> => replay.send(method, params, session),
      registry: replay.registry,
      contexts: new ExecutionContexts(),
    };
    document.body.innerHTML = recordedHtml('hidden');
    const value = ' Visible again ';
    // The preload compacts candidate text, NOT the query.
    const candidates = Array.from(document.querySelectorAll('*')).filter(
      (n) => !['html', 'body'].includes(n.tagName.toLowerCase()),
    );
    expect(
      candidates.filter((n) =>
        (n.textContent ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120)
          .includes(value),
      ),
    ).toHaveLength(0);
    expect(await probeMatches(deps, model, { text: value })).toMatchObject({
      matchCount: 0,
    });
  });

  it('must match ordinary light-DOM text on a label wrapping a password input', async () => {
    const recording = loadRecording('secrets');
    const replay = recordedDeps(recording);
    const model = await buildPageModel(replay);
    const deps = {
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ): Promise<unknown> => replay.send(method, params, session),
      registry: replay.registry,
      contexts: new ExecutionContexts(),
    };
    document.body.innerHTML = recordedHtml('secrets');
    const label = document.querySelector('#password')?.closest('label');
    expect((label?.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(
      'Password',
    );
    expect(await probeMatches(deps, model, { text: 'Password' })).toMatchObject(
      { matchCount: 1 },
    );
  });
});

describe('review R1 follow-ups', () => {
  function retaining(
    replay: ReturnType<typeof recordedDeps>,
    send: ActionTargetDeps['send'] = (
      method,
      params,
      session,
    ): Promise<unknown> => replay.send(method, params, session),
  ): ActionTargetDeps {
    return {
      registry: replay.registry,
      contexts: new ExecutionContexts(),
      send: (method, params, session): Promise<unknown> => {
        if (method === 'DOM.resolveNode')
          return Promise.resolve({
            object: { objectId: `node-${String(params.backendNodeId)}` },
          });
        if (method === 'Runtime.callFunctionOn')
          return Promise.resolve({ result: { value: true } });
        if (
          method === 'DOM.querySelectorAll' &&
          typeof params.selector === 'string' &&
          params.selector.startsWith('[[')
        )
          return Promise.reject(new Error('DOM Error while querying'));
        return send(method, params, session);
      },
    };
  }

  it('keeps the first label match only within one frame, also under a frame selector that selects several', async () => {
    const recording = cloneRecording(loadRecording('frames'));
    const root = treeRoot(recording);
    const nested = findTreeNode(
      root,
      (n) =>
        n.nodeName === 'BUTTON' &&
        Array.isArray(n.attributes) &&
        n.attributes.includes('nested-button'),
    );
    const nestedBody = findTreeNode(
      root,
      (n) =>
        n.nodeName === 'BODY' &&
        Array.isArray(n.children) &&
        n.children.includes(nested),
    );
    appendChild(
      nestedBody,
      elementRecord(99011, 'label', { for: 'nested-button' }, [
        textRecord(99012, 'Name'),
      ]),
    );
    const replay = recordedDeps(recording);
    const model = await buildPageModel(replay);
    const deps = retaining(replay);
    // `iframe` selects the child frame and the nested one.
    const scoped = await resolveLocatorTarget(
      deps,
      model,
      "page.getByLabel('Name')",
      'iframe',
    );
    expect(scoped).toMatchObject({ status: 'target_ambiguous' });
    if (scoped.status !== 'target_ambiguous') throw new Error('unreachable');
    expect(
      new Set(scoped.candidates.map((candidate) => candidate.frameRef)).size,
    ).toBe(2);
    // One frame: the preload's first-match rule.
    expect(
      await resolveLocatorTarget(
        deps,
        model,
        "page.getByLabel('Name')",
        'iframe#framed',
      ),
    ).toMatchObject({ status: 'found' });
  });

  it('applies strict CSS to every nested selector in wait mode, and treats nested invalid CSS as invalid input for a target', async () => {
    const replay = recordedDeps(loadRecording('frames'));
    const model = await buildPageModel(replay);
    const deps = retaining(replay);
    for (const locator of [
      "page.frameLocator('[[').locator('button')",
      "page.frameLocator('iframe#framed').locator('[[')",
    ]) {
      await expect(probeMatches(deps, model, { locator })).rejects.toThrow(
        /Invalid CSS locator/,
      );
      // As page.locator('[[') at top level: not a silent miss.
      expect(await resolveLocatorTarget(deps, model, locator)).toMatchObject({
        status: 'invalid_locator',
      });
    }
  });

  it('compares getByText against the raw query, like the preload', async () => {
    const replay = recordedDeps(loadRecording('hidden'));
    const model = await buildPageModel(replay);
    const deps = retaining(replay);
    expect(
      await resolveLocatorTarget(
        deps,
        model,
        "page.getByText(' Visible again ')",
      ),
    ).toMatchObject({ status: 'target_not_found' });
    expect(
      await resolveLocatorTarget(
        deps,
        model,
        "page.getByText('Visible again')",
      ),
    ).toMatchObject({ status: 'found' });
    const long = 'x'.repeat(121);
    expect(await probeMatches(deps, model, { text: long })).toMatchObject({
      matchCount: 0,
    });
  });

  it('never matches the content of secret controls, and keeps D13 labels empty for matching', async () => {
    const secrets = recordedDeps(loadRecording('secrets'));
    const secretModel = await buildPageModel(secrets);
    const secretDeps = retaining(secrets);
    // (The page's own script text contains "SEED-"; it is ordinary text.)
    for (const text of ['SEED-OPTION-8228', 'SEED-TEXTAREA-3390']) {
      expect([
        text,
        (await probeMatches(secretDeps, secretModel, { text })).matchCount,
      ]).toEqual([text, 0]);
    }
    const shadow = recordedDeps(loadRecording('shadow'));
    const shadowModel = await buildPageModel(shadow);
    // The shadow label wrapping the revealed password stays text-less.
    expect(
      (
        await probeMatches(retaining(shadow), shadowModel, {
          text: 'Saved password',
        })
      ).matchCount,
    ).toBe(0);
  });
});
