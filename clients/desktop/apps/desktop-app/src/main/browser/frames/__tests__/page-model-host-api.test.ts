import type { BrowserPageModel } from '../model-types';
import type { ResolvedActionTarget } from '../action-targets';
import { DESCRIBE_FUNCTION, FILL_FUNCTION } from '../target-state';
import { BrowserReadTargetError } from '@canopy/desktop-shared/browser/read-target-error';
import { loadRecording } from './fixtures/recorded-cdp';
import { recordedHost, type ExtraAnswer } from './fixtures/recorded-host';

const PAGE: BrowserPageModel['page'] = {
  browserId: 'api',
  url: 'https://example.test/',
  title: 'API',
  viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
  themeMode: 'light',
};
const page = (): Promise<BrowserPageModel['page']> => Promise.resolve(PAGE);

/** Answers the action pipeline's own requests like Chromium. */
const pipeline: ExtraAnswer = (method, params) => {
  if (method === 'DOM.resolveNode')
    return Promise.resolve({
      object: {
        objectId: `${params.executionContextId === undefined ? 'main' : 'host'}:${String(params.backendNodeId)}`,
      },
    });
  if (method === 'Page.createIsolatedWorld')
    return Promise.resolve({ executionContextId: 81 });
  if (method === 'DOM.describeNode')
    return Promise.resolve({
      node: { nodeId: 0, backendNodeId: params.backendNodeId, nodeType: 1 },
    });
  if (
    method === 'Runtime.evaluate' &&
    params.expression === 'document.readyState'
  )
    return Promise.resolve({ result: { type: 'string', value: 'complete' } });
  if (method === 'Runtime.callFunctionOn') {
    if (params.functionDeclaration === FILL_FUNCTION)
      return Promise.resolve({ result: { value: 'filled' } });
    if (params.functionDeclaration === DESCRIBE_FUNCTION)
      return Promise.resolve({
        result: {
          value: {
            connected: true,
            tagName: 'button',
            attributes: {},
            disabled: false,
            rect: { x: 1, y: 2, width: 3, height: 4 },
            viewport: { width: 300, height: 150 },
            focused: false,
          },
        },
      });
    return Promise.resolve({ result: { value: true } });
  }
  return undefined;
};

describe('PageModelHost API for the cutover', () => {
  it('filters a snapshot to the frame field and reports an unavailable frame', async () => {
    const { host } = recordedHost(loadRecording('frames'), pipeline);
    const all = await host.snapshot({ browserId: 'api', limit: 100 }, page);
    const childRef = all.inputs.find(
      (row) => row.name === 'Frame action',
    )?.frameRef;
    if (!childRef) throw new Error('Missing child frame row');
    for (const frame of [childRef, 'iframe#framed']) {
      const scoped = await host.snapshot(
        { browserId: 'api', limit: 100 },
        page,
        { frame },
      );
      expect(scoped.inputs.length).toBeGreaterThan(0);
      expect(scoped.inputs.every((row) => row.frameRef === childRef)).toBe(
        true,
      );
      expect(scoped.total).toBe(scoped.inputs.length);
      expect(scoped.frames).toEqual(all.frames);
    }
    await expect(
      host.snapshot({ browserId: 'api', limit: 100 }, page, {
        frame: 'iframe#missing',
      }),
    ).rejects.toMatchObject({
      code: 'frame_unavailable',
      message:
        "No frame matches the frame field. Run browser.input_snapshot without frame to list the page's frames.",
    });
  });

  it('inspects a locator in the frame field', async () => {
    const { host } = recordedHost(loadRecording('frames'), pipeline);
    const inspected = await host.inspect(
      { browserId: 'api', locator: "page.locator('button')" },
      page,
      { frame: 'iframe#framed' },
    );
    expect(inspected.accessibleName).toBe('Frame action');
    await expect(
      host.inspect(
        { browserId: 'api', locator: "page.locator('button')" },
        page,
        {
          frame: 'iframe#missing',
        },
      ),
    ).rejects.toMatchObject({ code: 'frame_unavailable' });
  });

  it('resolves, describes, fills and releases one target', async () => {
    const { host, sent } = recordedHost(loadRecording('frames'), pipeline);
    const resolution = await host.resolveActionTarget({
      kind: 'locator',
      locator: "page.locator('#frame-name')",
    });
    if (resolution.status !== 'found') throw new Error(resolution.status);
    const target = resolution.target;
    expect(target.outOfProcess).toBe(false);
    const count = (method: string): number =>
      sent.filter((entry) => entry.method === method).length;
    const builds = count('DOM.getDocument');
    const queries = count('DOM.querySelectorAll');
    const fencedCalls: Array<{
      method: string;
      params: Record<string, unknown>;
      sessionId: string;
    }> = [];
    const fencedSend = (
      method: string,
      params: Record<string, unknown>,
      sessionId = '',
    ): Promise<unknown> => {
      fencedCalls.push({ method, params, sessionId });
      if (method === 'Page.createIsolatedWorld')
        return Promise.resolve({ executionContextId: 82 });
      if (method === 'DOM.resolveNode')
        return Promise.resolve({
          object: { objectId: `host:${String(params.backendNodeId)}` },
        });
      if (
        method === 'Runtime.callFunctionOn' &&
        params.functionDeclaration === FILL_FUNCTION
      )
        return Promise.resolve({ result: { value: 'filled' } });
      return Promise.resolve(undefined);
    };
    expect(
      await host.fillActionTarget(target, 'Ada', undefined, fencedSend),
    ).toBe('filled');
    const fillCall = fencedCalls.find(
      (entry) =>
        entry.method === 'Runtime.callFunctionOn' &&
        entry.params.functionDeclaration === FILL_FUNCTION,
    );
    expect(fillCall?.params).toMatchObject({
      functionDeclaration: FILL_FUNCTION,
      userGesture: true,
      arguments: [{ value: 'Ada' }],
    });
    expect(fillCall?.sessionId).toBe(target.identity.sessionId);
    expect(await host.describeActionTarget(target)).toMatchObject({
      tagName: 'button',
      ref: target.ref,
    });
    // Describe reads the cached model and never re-runs the locator.
    expect(count('DOM.getDocument')).toBe(builds);
    expect(count('DOM.querySelectorAll')).toBe(queries);
    await host.releaseActionTarget(target);
    expect(sent[sent.length - 1]).toMatchObject({
      method: 'Runtime.releaseObjectGroup',
      params: { objectGroup: target.objectGroup },
    });
    expect(await host.mapToAncestors(target, { x: 5, y: 5 })).toEqual({
      status: 'mapped',
      hops: [],
    });
  });

  it('resolves a ref and the focused element through the host', async () => {
    const { host } = recordedHost(loadRecording('frames'), pipeline);
    const snapshot = await host.snapshot(
      { browserId: 'api', limit: 100 },
      page,
    );
    const row = snapshot.inputs.find((item) => item.name === 'Frame action');
    if (!row) throw new Error('Missing row');
    expect(
      await host.resolveActionTarget({ kind: 'ref', ref: row.ref }),
    ).toMatchObject({ status: 'found', target: { ref: row.ref } });
    expect(
      await host.resolveActionTarget({ kind: 'ref', ref: 'r-gone-1' }),
    ).toMatchObject({ status: 'target_stale' });
  });

  it('projects a resolved target into the isolated host world without changing its identity or group', async () => {
    const { host, sent } = recordedHost(loadRecording('frames'), pipeline);
    const resolution = await host.resolveActionTarget({
      kind: 'locator',
      locator: "page.locator('#frame-name')",
    });
    if (resolution.status !== 'found') throw new Error(resolution.status);
    const target = resolution.target;
    const hostTarget = await host.hostActionTarget(target);
    if (!hostTarget)
      throw new Error('Target did not resolve in the host world.');

    expect(hostTarget.identity).toBe(target.identity);
    expect(hostTarget.objectGroup).toBe(target.objectGroup);
    expect(hostTarget.objectId).toBe(`host:${target.identity.backendNodeId}`);
    expect(
      sent.find(
        (call) =>
          call.method === 'DOM.resolveNode' &&
          call.params.executionContextId === 81 &&
          call.params.backendNodeId === target.identity.backendNodeId,
      ),
    ).toMatchObject({
      method: 'DOM.resolveNode',
      params: {
        backendNodeId: target.identity.backendNodeId,
        executionContextId: 81,
        objectGroup: target.objectGroup,
      },
    });
  });

  it('uses model secrecy for values, inside-secret options, and controlled lists without a live read', async () => {
    const { host, sent } = recordedHost(loadRecording('secrets'), pipeline);
    const { model } = await host.build();
    const otp = model.nodes.find((node) => node.attributes.id === 'otp');
    if (!otp) throw new Error('Missing OTP model node.');
    const secret = await host.resolveActionTarget({
      kind: 'ref',
      ref: host.registry.mintRef(otp.identity),
    });
    if (secret.status !== 'found') throw new Error(secret.status);
    expect(await host.isActionTargetSecret(secret.target)).toBe(true);

    const secretOption = model.nodes.find((node) => node.insideSecretSelect);
    if (!secretOption) throw new Error('Missing inside-secret option row.');
    const optionRef = host.registry.mintRef(secretOption.identity);
    const option = await host.resolveActionTarget({
      kind: 'ref',
      ref: optionRef,
    });
    if (option.status !== 'found') throw new Error(option.status);
    expect(await host.isActionTargetSecret(option.target)).toBe(true);

    const missingTarget: ResolvedActionTarget = {
      identity: {
        ...secret.target.identity,
        backendNodeId: secret.target.identity.backendNodeId + 10_000,
      },
      frameRef: secret.target.frameRef,
      objectId: 'main:missing',
      objectGroup: secret.target.objectGroup,
      outOfProcess: false,
    };
    sent.length = 0;
    expect(await host.isActionTargetSecret(missingTarget)).toBe(true);
    expect(
      sent.some((entry) => entry.method === 'Runtime.callFunctionOn'),
    ).toBe(false);

    const controlled = recordedHost(loadRecording('form-controls'), pipeline);
    const { model: controlledModel } = await controlled.host.build();
    const combo = controlledModel.nodes.find(
      (node) => node.attributes.id === 'search',
    );
    const list = controlledModel.nodes.find(
      (node) => node.attributes.id === 'search-label',
    );
    if (!combo || !list) throw new Error('Missing combobox/list model nodes.');
    combo.attributes.role = 'combobox';
    combo.attributes['aria-controls'] = 'private-list';
    list.attributes.id = 'private-list';
    list.attributes.role = 'listbox';
    list.secret = true;
    const publicCombo = await controlled.host.resolveActionTarget({
      kind: 'ref',
      ref: controlled.host.registry.mintRef(combo.identity),
    });
    if (publicCombo.status !== 'found') throw new Error(publicCombo.status);
    expect(await controlled.host.isActionTargetSecret(publicCombo.target)).toBe(
      true,
    );
  });

  it('does not treat a control as secret because the list it names is not mounted yet', async () => {
    const { host } = recordedHost(loadRecording('form-controls'), pipeline);
    const { model } = await host.build();
    const resolve = async (
      node: (typeof model.nodes)[number],
    ): Promise<ResolvedActionTarget> => {
      const resolved = await host.resolveActionTarget({
        kind: 'ref',
        ref: host.registry.mintRef(node.identity),
      });
      if (resolved.status !== 'found') throw new Error(resolved.status);
      return resolved.target;
    };
    // A span, since an input with unknown password history is secret here.
    const combo = model.nodes.find(
      (node) => node.attributes.id === 'search-hint',
    );
    if (!combo) throw new Error('Missing combobox model node.');
    combo.attributes.role = 'combobox';
    combo.attributes['aria-controls'] = 'popup-mounts-on-open';
    expect(await host.isActionTargetSecret(await resolve(combo))).toBe(false);
  });

  it("looks up a named list only in the control's own tree scope", async () => {
    const { host } = recordedHost(loadRecording('form-controls'), pipeline);
    const { model } = await host.build();
    const byId = (id: string): (typeof model.nodes)[number] => {
      const node = model.nodes.find(
        (candidate) => candidate.attributes.id === id,
      );
      if (!node) throw new Error(`Missing ${id} model node.`);
      return node;
    };
    const combo = byId('search-hint');
    const secretWrapper = byId('search-label');
    const publicList = model.nodes.find(
      (node) =>
        node.nodeType === 1 &&
        node !== combo &&
        node !== secretWrapper &&
        !node.secret &&
        !node.hasSecretDescendant &&
        node.childIndexes.every((index) => model.nodes[index]?.nodeType === 3),
    );
    if (!publicList) throw new Error('Missing a plain element node.');
    combo.attributes.role = 'combobox';
    combo.attributes['aria-controls'] = 'options';
    // The model withholds the id of a wrapper inside a secret list.
    secretWrapper.attributes.id = '[redacted]';
    secretWrapper.scopeNodeId = combo.scopeNodeId;
    // Another component's ordinary list, in another shadow root.
    publicList.attributes.id = 'options';
    publicList.attributes.role = 'listbox';
    publicList.scopeNodeId = combo.scopeNodeId + 100_000;
    const resolved = await host.resolveActionTarget({
      kind: 'ref',
      ref: host.registry.mintRef(combo.identity),
    });
    if (resolved.status !== 'found') throw new Error(resolved.status);
    expect(await host.isActionTargetSecret(resolved.target)).toBe(true);
  });

  it('probes wait_for conditions; a load-state probe builds no model', async () => {
    const { host, sent } = recordedHost(loadRecording('frames'), pipeline);
    expect(await host.waitProbe({})).toEqual({
      matchCount: 0,
      visibleCount: 0,
      readyState: 'complete',
    });
    expect(sent.some((entry) => entry.method === 'DOM.getDocument')).toBe(
      false,
    );
    expect(await host.waitProbe({ locator: "page.locator('button')" })).toEqual(
      { matchCount: 4, visibleCount: 4, readyState: 'complete' },
    );
  });
});

describe('inspect says where the element is', () => {
  it('reports the frameRef of a child-frame element and none for the top document', async () => {
    const { host } = recordedHost(loadRecording('frames'), pipeline);
    const child = await host.inspect(
      {
        browserId: 'api',
        locator: "page.getByRole('button', { name: 'Frame action' })",
      },
      page,
    );
    expect(child.frameRef).toMatch(/^f-/);
    expect(child).not.toHaveProperty('inShadowRoot');
    const top = await host.inspect(
      {
        browserId: 'api',
        locator: "page.getByRole('button', { name: 'Before frame' })",
      },
      page,
    );
    expect(top).not.toHaveProperty('frameRef');
    expect(top).not.toHaveProperty('inShadowRoot');
  });

  it('reports a shadow-root element', async () => {
    const { host } = recordedHost(loadRecording('shadow'), pipeline);
    const inShadow = await host.inspect(
      {
        browserId: 'api',
        locator: "page.getByRole('button', { name: 'Open action' })",
      },
      page,
    );
    expect(inShadow).toMatchObject({ inShadowRoot: true });
    expect(inShadow).not.toHaveProperty('frameRef');
  });
});

describe('rows say where an element is only when there is something to say (E1)', () => {
  it('marks child-frame rows with their frameRef and shadow rows with inShadowRoot, and nothing else', async () => {
    for (const name of ['frames', 'shadow'] as const) {
      const { host } = recordedHost(loadRecording(name), pipeline);
      const { model } = await host.build();
      const rootRef = model.frames[0]?.frameRef;
      const all = await host.snapshot({ browserId: 'api', limit: 100 }, page);
      for (const row of all.inputs) {
        expect([row.name, Object.keys(row).includes('frameRef')]).toEqual([
          row.name,
          row.frameRef !== undefined,
        ]);
        expect(row.frameRef).not.toBe(rootRef);
        if (row.inShadowRoot !== undefined) expect(row.inShadowRoot).toBe(true);
      }
      if (name === 'frames')
        expect(all.inputs.some((row) => row.frameRef !== undefined)).toBe(true);
      else
        expect(all.inputs.some((row) => row.inShadowRoot === true)).toBe(true);
    }
  });

  it("lists the top document in frame coverage, and its frameRef scopes a snapshot to the top document's rows", async () => {
    const { host } = recordedHost(loadRecording('frames'), pipeline);
    const { model } = await host.build();
    const rootRef = model.frames[0]?.frameRef;
    if (!rootRef) throw new Error('No root frame');
    const all = await host.snapshot({ browserId: 'api', limit: 100 }, page);
    expect(all.frames?.[0]).toMatchObject({
      frameRef: rootRef,
      status: 'included',
    });
    const top = await host.snapshot({ browserId: 'api', limit: 100 }, page, {
      frame: rootRef,
    });
    expect(top.inputs.length).toBeGreaterThan(0);
    expect(top.inputs.every((row) => row.frameRef === undefined)).toBe(true);
    expect(top.total).toBe(
      all.inputs.filter((row) => row.frameRef === undefined).length,
    );
  });
});

describe('inspect by coordinates', () => {
  it('resolves the point with the root hit test, and releases what it retained', async () => {
    const recording = loadRecording('frames');
    let beforeId = 0;
    const { host, sent } = recordedHost(recording, (method, params) => {
      if (method === 'DOM.getNodeForLocation')
        return beforeId === 0
          ? Promise.reject(new Error('No node found at given location'))
          : Promise.resolve({
              backendNodeId: beforeId,
              frameId: recording.frames.find((frame) => !frame.parentId)
                ?.frameId,
            });
      return pipeline(method, params, '');
    });
    const { model } = await host.build();
    beforeId =
      model.nodes.find((node) => node.attributes.id === 'before')?.identity
        .backendNodeId ?? 0;
    const inspected = await host.inspect(
      { browserId: 'api', x: 20, y: 30 },
      page,
    );
    expect(inspected).toMatchObject({
      tagName: 'button',
      accessibleName: 'Before frame',
    });
    expect(sent.map((entry) => entry.method)).toContain(
      'Runtime.releaseObjectGroup',
    );
    beforeId = 0;
    await expect(
      host.inspect({ browserId: 'api', x: 5_000, y: 5_000 }, page),
    ).rejects.toMatchObject({ code: 'target_not_found' });
  });
});

describe('read failures are typed, with plain messages (E3)', () => {
  it.each([
    [
      { ref: 'r-00000000-0000-0000-0000-000000000000-1' },
      'target_stale',
      'That reference is no longer on the page. Run browser.input_snapshot for current references.',
    ],
    [
      { locator: "page.locator('#nothing-here')" },
      'target_not_found',
      'No element matches the target. Run browser.input_snapshot for current references.',
    ],
    [
      { locator: "page.locator('button')" },
      'target_ambiguous',
      expect.stringMatching(
        /^The locator matches 4 elements, in frames f-[^ ]+, f-[^ ]+, f-[^ ]+\. Add frame, use a more specific locator, or use a reference from browser\.input_snapshot\.$/,
      ),
    ],
    [
      { locator: "page.getByTitle('x')" },
      'invalid_locator',
      expect.stringContaining('Unsupported Playwright-like locator'),
    ],
  ] as const)(
    'inspect %j fails with %s',
    async (target, code, message: unknown) => {
      const { host } = recordedHost(loadRecording('frames'), pipeline);
      const failure: unknown = await host
        .inspect({ browserId: 'api', ...target }, page)
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(BrowserReadTargetError);
      expect(failure).toMatchObject({ code, message });
      expect(String(failure)).toMatch(/^BrowserReadTargetError\[/);
    },
  );

  it('a point in a frame that cannot be read says so, not that the frame field matched nothing', async () => {
    const recording = loadRecording('frames');
    let beforeId = 0;
    const { host } = recordedHost(recording, (method, params) =>
      method === 'DOM.getNodeForLocation'
        ? Promise.resolve({
            backendNodeId: beforeId,
            frameId: 'not-registered',
          })
        : pipeline(method, params, ''),
    );
    const { model } = await host.build();
    beforeId =
      model.nodes.find((node) => node.attributes.id === 'before')?.identity
        .backendNodeId ?? 0;
    await expect(
      host.inspect({ browserId: 'api', x: 20, y: 30 }, page),
    ).rejects.toMatchObject({
      code: 'frame_unavailable',
      message:
        "The element at that point is in a frame that can't be read. Run browser.input_snapshot for current references.",
    });
  });
});
