import type { NodeIdentity } from '../frame-registry';
import {
  LocatorRequestError,
  matchLocator,
  resolveFrameScope,
} from '../locator-requests';
import type { BrowserPageModel, PageModelDeps } from '../model-types';
import { buildPageModel } from '../page-model';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
} from './fixtures/recorded-cdp';

/** Chromium's answer to `DOM.querySelectorAll` with an unparsable selector. */
const INVALID_SELECTOR = 'DOM Error while querying';

async function model(name: string): Promise<{
  model: BrowserPageModel;
  send: PageModelDeps['send'];
}> {
  const recording = loadRecording(name);
  const replay = recordedSend(recording);
  const send: PageModelDeps['send'] = (method, params, sessionId) =>
    method === 'DOM.querySelectorAll' &&
    typeof params.selector === 'string' &&
    /^\[\[|^\s*$/.test(params.selector)
      ? Promise.reject(new Error(INVALID_SELECTOR))
      : replay(method, params, sessionId);
  return {
    model: await buildPageModel(recordedDeps(recording)),
    send,
  };
}

function ids(built: BrowserPageModel, identities: NodeIdentity[]): string[] {
  return identities.map(
    (identity) =>
      built.nodes.find(
        (node) =>
          node.identity.sessionId === identity.sessionId &&
          node.identity.backendNodeId === identity.backendNodeId,
      )?.attributes.id ?? '?',
  );
}

describe('frame scope (the optional frame field)', () => {
  it('accepts a frameRef or a CSS selector for the iframe element', async () => {
    const { model: built, send } = await model('frames');
    const child = built.frames[1];
    if (!child) throw new Error('Missing child frame');
    expect(await resolveFrameScope(built, { send }, child.frameRef)).toEqual([
      child,
    ]);
    expect(await resolveFrameScope(built, { send }, 'iframe#framed')).toEqual([
      child,
    ]);
    expect(
      (await resolveFrameScope(built, { send }, 'iframe#nested'))?.map(
        (frame) => frame.depth,
      ),
    ).toEqual([2]);
  });

  it('reports an unknown, stale, omitted or unmatched frame as unavailable', async () => {
    const { model: built, send } = await model('frames');
    const child = built.frames[1];
    if (!child) throw new Error('Missing child frame');
    const unknownRef = child.frameRef.replace(/-\d+$/, '-999');
    expect(
      await resolveFrameScope(built, { send }, unknownRef),
    ).toBeUndefined();
    expect(
      await resolveFrameScope(built, { send }, 'iframe#missing'),
    ).toBeUndefined();
    expect(await resolveFrameScope(built, { send }, '[[')).toBeUndefined();
    built.registry.noteFrameNavigated(child.sessionId, {
      id: child.frameId,
      loaderId: 'replaced',
      url: 'about:srcdoc',
      parentId: child.parentFrameId,
    });
    expect(
      await resolveFrameScope(built, { send }, child.frameRef),
    ).toBeUndefined();

    const oopif = await model('oopif');
    const omitted = oopif.model.coverage.find(
      (entry) => entry.status === 'omitted' && entry.frameRef,
    );
    if (!omitted) throw new Error('Missing omitted frame');
    expect(
      await resolveFrameScope(
        oopif.model,
        { send: oopif.send },
        omitted.frameRef,
      ),
    ).toBeUndefined();
    expect(
      await resolveFrameScope(
        oopif.model,
        { send: oopif.send },
        'iframe#tiny-frame',
      ),
    ).toBeUndefined();
  });
});

describe('locator requests for action targets', () => {
  it('matches across every frame, or only in the scoped frames', async () => {
    const { model: built, send } = await model('frames');
    const all = await matchLocator(
      built,
      { send },
      "page.locator('button')",
      built.frames,
      'target',
    );
    expect(ids(built, all)).toEqual([
      'before',
      'frame-button',
      'nested-button',
      'after',
    ]);
    const child = built.frames[1];
    if (!child) throw new Error('Missing child frame');
    expect(
      ids(
        built,
        await matchLocator(
          built,
          { send },
          "page.locator('button')",
          [child],
          'target',
        ),
      ),
    ).toEqual(['frame-button']);
    expect(
      ids(
        built,
        await matchLocator(
          built,
          { send },
          "page.frameLocator('iframe#framed').getByText('Frame action')",
          built.frames,
          'target',
        ),
      ),
    ).toEqual(['frame-button']);
  });

  it('honors getByText exact, which rules out substring matches', async () => {
    const { model: built, send } = await model('frames');
    const match = async (locator: string): Promise<string[]> =>
      ids(
        built,
        await matchLocator(built, { send }, locator, built.frames, 'target'),
      );
    expect(await match("page.getByText('Frame act')")).toEqual([
      'frame-button',
    ]);
    expect(await match("page.getByText('Frame act', { exact: true })")).toEqual(
      [],
    );
    expect(
      await match("page.getByText('Frame action', { exact: true })"),
    ).toEqual(['frame-button']);
  });

  it('names the supported form for Playwright-only text pseudo-classes', async () => {
    const { model: built } = await model('frames');
    const send: PageModelDeps['send'] = () =>
      Promise.reject(new Error(INVALID_SELECTOR));
    const failure = await matchLocator(
      built,
      { send },
      "td:text-is('NCR')",
      built.frames,
      'target',
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ kind: 'invalid_css' });
    expect(String(failure)).toMatch(
      /:has-text\(\), :text\(\), :text-is\(\) and :text-matches\(\) are Playwright-only\. Use page\.getByText/,
    );
    const chain = await matchLocator(
      built,
      { send },
      'div.figure img >> nth=0',
      built.frames,
      'target',
    ).catch((error: unknown) => error);
    expect(String(chain)).toMatch(
      /Playwright selector chains \(>>\) are not supported/,
    );
  });

  it('rejects unsupported locators the way the preload does', async () => {
    const { model: built, send } = await model('frames');
    for (const locator of ["page.getByTitle('x')", "page.locator('[[')"]) {
      await expect(
        matchLocator(built, { send }, locator, built.frames, 'target'),
      ).rejects.toMatchObject({ kind: 'unsupported' });
    }
    // Invalid CSS is reported, not a silent miss the agent reads as "not found".
    for (const locator of ['css=[[', '[[']) {
      const failure = await matchLocator(
        built,
        { send },
        locator,
        built.frames,
        'target',
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: 'invalid_css' });
      expect(String(failure)).toMatch(/Invalid CSS locator/);
    }
  });

  it('takes the first match for alt text and labels, like the preload', async () => {
    const { model: built, send } = await model('form-controls');
    const labels = await matchLocator(
      built,
      { send },
      'getByLabel("e")',
      built.frames,
      'wait',
    );
    expect(labels.length).toBeGreaterThan(1);
    const first = await matchLocator(
      built,
      { send },
      'getByLabel("e")',
      built.frames,
      'target',
    );
    expect(first).toEqual([labels[0]]);
  });
});

describe('locator requests for wait_for', () => {
  it('rejects invalid CSS with an invalid-target error and matches nothing for empty locators', async () => {
    const { model: built, send } = await model('frames');
    for (const locator of ["page.locator('[[')", 'css=[[', '[[']) {
      const failure = await matchLocator(
        built,
        { send },
        locator,
        built.frames,
        'wait',
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LocatorRequestError);
      expect(failure).toMatchObject({ kind: 'invalid_css' });
      expect(String(failure)).toMatch(/Invalid CSS locator/);
    }
    for (const locator of ["page.locator('')", 'css=', '   ']) {
      expect(
        await matchLocator(built, { send }, locator, built.frames, 'wait'),
      ).toEqual([]);
    }
    await expect(
      matchLocator(
        built,
        { send },
        "page.getByTitle('x')",
        built.frames,
        'wait',
      ),
    ).rejects.toMatchObject({ kind: 'unsupported' });
  });
});
