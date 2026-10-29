import {
  resolveRefTarget,
  type ActionTargetDeps,
  type ResolvedActionTarget,
} from '../action-targets';
import { ExecutionContexts } from '../execution-contexts';
import { HOST_WORLD_NAME } from '../host-cdp';
import type { BrowserPageModel, PageModelNode } from '../model-types';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot } from '../projections';
import {
  DESCRIBE_FUNCTION,
  describeActionTarget,
  FILL_FUNCTION,
  fillActionTarget,
} from '../target-state';
import {
  loadRecording,
  recordedDeps,
  recordedSend,
} from './fixtures/recorded-cdp';

interface Sent {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
}

interface Scenario {
  /** What the description function reports per backend node id. */
  describe?: (backendNodeId: number) => unknown;
  fill?: unknown;
  /** Backend node ids of owners whose document has them focused. */
  focusedOwners?: number[];
  failResolveIn?: 'host';
}

async function setup(
  name: string,
  scenario: Scenario,
): Promise<{
  deps: ActionTargetDeps;
  model: BrowserPageModel;
  sent: Sent[];
}> {
  const recording = loadRecording(name);
  const replay = recordedSend(recording);
  const sent: Sent[] = [];
  let world = 70;
  const owners = new Map<string, number>();
  const send: ActionTargetDeps['send'] = (method, params, sessionId = '') => {
    sent.push({ method, params, sessionId });
    if (method === 'Page.createIsolatedWorld') {
      world += 1;
      return Promise.resolve({ executionContextId: world });
    }
    if (method === 'DOM.resolveNode') {
      if (
        scenario.failResolveIn === 'host' &&
        params.executionContextId !== undefined
      )
        return Promise.reject(new Error('No node with given id found'));
      const context = params.executionContextId;
      const where = typeof context === 'number' ? `world${context}` : 'main';
      return Promise.resolve({
        object: { objectId: `${where}:${String(params.backendNodeId)}` },
      });
    }
    if (method === 'DOM.getFrameOwner') {
      const owner = owners.get(String(params.frameId));
      return owner === undefined
        ? Promise.reject(new Error('Frame with given id not found'))
        : Promise.resolve({ backendNodeId: owner });
    }
    if (method === 'Runtime.callFunctionOn') {
      const objectId = String(params.objectId);
      const backendNodeId = Number(objectId.split(':')[1]);
      if (params.functionDeclaration === DESCRIBE_FUNCTION)
        return Promise.resolve({
          result: { value: scenario.describe?.(backendNodeId) },
        });
      if (params.functionDeclaration === FILL_FUNCTION)
        return Promise.resolve({ result: { value: scenario.fill } });
      if (objectId.startsWith('main:'))
        return Promise.resolve({ result: { value: true } });
      // The owner-focus check in an ancestor document.
      return Promise.resolve({
        result: {
          value: scenario.focusedOwners?.includes(backendNodeId) === true,
        },
      });
    }
    return replay(method, params, sessionId);
  };
  const replayDeps = recordedDeps(recording);
  const model = await buildPageModel(replayDeps);
  for (const frame of model.frames) {
    const owner =
      frame.ownerNodeIndex === undefined
        ? undefined
        : model.nodes[frame.ownerNodeIndex];
    if (owner) owners.set(frame.frameId, owner.identity.backendNodeId);
  }
  return {
    deps: {
      send,
      registry: replayDeps.registry,
      contexts: new ExecutionContexts(),
    },
    model,
    sent,
  };
}

function nodeWithId(model: BrowserPageModel, id: string): PageModelNode {
  const node = model.nodes.find((candidate) => candidate.attributes.id === id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

async function targetFor(
  deps: ActionTargetDeps,
  model: BrowserPageModel,
  id: string,
): Promise<ResolvedActionTarget> {
  const node = nodeWithId(model, id);
  const row = projectInputSnapshot(
    model,
    { browserId: 'state', limit: 100 },
    { browserId: 'state', url: '', title: '' },
  ).inputs.find(
    (item) =>
      model.registry.resolveRef(item.ref)?.backendNodeId ===
      node.identity.backendNodeId,
  );
  if (!row) throw new Error(`No row for #${id}`);
  const resolution = await resolveRefTarget(deps, row.ref);
  if (resolution.status !== 'found') throw new Error(resolution.status);
  return resolution.target;
}

const read = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  connected: true,
  tagName: 'button',
  attributes: { type: 'button' },
  disabled: false,
  rect: { x: 10.4, y: 20.6, width: 80.2, height: 19.5 },
  viewport: { width: 1280, height: 800 },
  focused: false,
  ...overrides,
});

describe('describing a resolved target', () => {
  it('keeps a target secret in its description when it was secret before the action', async () => {
    const { deps, model, sent } = await setup('frames', {
      describe: () => read(),
    });
    const target = await targetFor(deps, model, 'before');
    sent.length = 0;
    await describeActionTarget(deps, model, target, { secret: true });
    const call = sent.find(
      (entry) => entry.params.functionDeclaration === DESCRIBE_FUNCTION,
    );
    expect(call?.params.arguments).toEqual([{ value: true }]);
  });

  it('reads the retained node in the host world, with the model name, ref and preload rounding', async () => {
    const { deps, model, sent } = await setup('frames', {
      describe: () => read({ focused: true }),
    });
    const target = await targetFor(deps, model, 'before');
    sent.length = 0;
    expect(await describeActionTarget(deps, model, target)).toEqual({
      tagName: 'button',
      role: 'button',
      name: 'Before frame',
      inputType: 'button',
      disabled: false,
      focused: true,
      inViewport: true,
      bounds: { x: 10, y: 21, width: 80, height: 20 },
      ref: target.ref,
    });
    expect(sent.map((entry) => entry.method)).toEqual([
      'Page.createIsolatedWorld',
      'DOM.resolveNode',
      'Runtime.callFunctionOn',
    ]);
    expect(sent[0]?.params).toEqual({
      frameId: target.identity.frameId,
      worldName: HOST_WORLD_NAME,
    });
    expect(sent[1]?.params).toMatchObject({
      backendNodeId: target.identity.backendNodeId,
      executionContextId: 71,
      objectGroup: target.objectGroup,
    });
  });

  it('maps a child-frame rect to top-level coordinates and requires each owner focused', async () => {
    const focusedEverywhere = await setup('frames', {
      describe: () => read({ focused: true }),
    });
    const { deps, model } = focusedEverywhere;
    const target = await targetFor(deps, model, 'frame-button');
    const frame = model.frames.find(
      (candidate) => candidate.frameId === target.identity.frameId,
    );
    if (!frame) throw new Error('Missing frame');
    const owner = model.nodes[frame.ownerNodeIndex ?? -1];
    const notFocused = await describeActionTarget(deps, model, target);
    const { x, y } = frame.viewportTransform;
    expect(notFocused).toMatchObject({
      bounds: {
        x: Math.round(x + 10.4),
        y: Math.round(y + 20.6),
        width: 80,
        height: 20,
      },
      // The owner iframe is not its document's active element.
      focused: false,
    });
    const withOwner = await setup('frames', {
      describe: () => read({ focused: true }),
      focusedOwners: owner ? [owner.identity.backendNodeId] : [],
    });
    const ownedTarget = await targetFor(
      withOwner.deps,
      withOwner.model,
      'frame-button',
    );
    expect(
      await describeActionTarget(withOwner.deps, withOwner.model, ownedTarget),
    ).toMatchObject({ focused: true, name: 'Frame action' });
  });

  it('is out of view when the rect misses the frame viewport or its visible part', async () => {
    const { deps, model } = await setup('frames', {
      describe: () => read({ rect: { x: 10, y: 900, width: 10, height: 10 } }),
    });
    const target = await targetFor(deps, model, 'frame-button');
    expect(await describeActionTarget(deps, model, target)).toMatchObject({
      inViewport: false,
    });
  });

  it('follows the checked rules and secrecy of the preload', async () => {
    const { deps, model } = await setup('form-controls', {
      describe: (backendNodeId) =>
        backendNodeId === nodeWithId(model, 'subscribe').identity.backendNodeId
          ? read({
              tagName: 'input',
              attributes: { type: 'checkbox' },
              checked: false,
            })
          : read({
              tagName: 'div',
              attributes: { role: 'switch', 'aria-checked': 'mixed' },
            }),
    });
    const box = await targetFor(deps, model, 'subscribe');
    expect(await describeActionTarget(deps, model, box)).toMatchObject({
      tagName: 'input',
      role: 'checkbox',
      inputType: 'checkbox',
      checked: false,
    });
  });

  it('decodes live D11 state from the host description', async () => {
    const { deps, model } = await setup('form-controls', {
      describe: () =>
        read({
          tagName: 'input',
          attributes: { type: 'checkbox', 'aria-checked': 'true' },
          checked: 'mixed',
          value: 'live value',
          selectedOptions: [{ value: 'blue', label: 'Blue option' }],
          invalid: true,
          validationMessage: 'Correct the value.',
        }),
    });
    const target = await targetFor(deps, model, 'subscribe');
    expect(await describeActionTarget(deps, model, target)).toMatchObject({
      checked: 'mixed',
      value: 'live value',
      selectedOptions: [{ value: 'blue', label: 'Blue option' }],
      invalid: true,
      validationMessage: 'Correct the value.',
    });
  });

  it('passes model secrecy into the page and withholds secret state even if CDP returns it', async () => {
    const { deps, model, sent } = await setup('secrets', {
      describe: () =>
        read({
          tagName: 'input',
          attributes: { type: 'text' },
          value: 'forbidden value',
          selectedOptions: [{ value: 'forbidden option', label: 'Private' }],
          invalid: true,
          validationMessage: 'forbidden message',
        }),
    });
    const target = await targetFor(deps, model, 'otp');
    sent.length = 0;
    const description = await describeActionTarget(deps, model, target);
    expect(description).toMatchObject({
      valueRedacted: true,
      invalid: true,
    });
    expect(description).not.toHaveProperty('value');
    expect(description).not.toHaveProperty('validationMessage');
    expect(description).not.toHaveProperty('selectedOptions');
    expect(JSON.stringify(description)).not.toContain('forbidden');
    const call = sent.find(
      (entry) => entry.params.functionDeclaration === DESCRIBE_FUNCTION,
    );
    expect(call?.params.arguments).toEqual([{ value: true }]);

    const optionNode = model.nodes.find(
      (candidate) => candidate.insideSecretSelect,
    );
    if (!optionNode) throw new Error('Missing secret select option');
    const optionResolution = await resolveRefTarget(
      deps,
      model.registry.mintRef(optionNode.identity),
    );
    if (optionResolution.status !== 'found')
      throw new Error(optionResolution.status);
    const secretOption = await describeActionTarget(
      deps,
      model,
      optionResolution.target,
    );
    expect(secretOption).not.toHaveProperty('name');
    expect(JSON.stringify(secretOption)).not.toContain('forbidden');
  });

  it('treats a model-secret controlled ARIA list as secret for its public combobox', async () => {
    const { deps, model, sent } = await setup('form-controls', {
      describe: () =>
        read({
          tagName: 'input',
          attributes: { role: 'combobox', type: 'search' },
          value: 'private query',
          selectedOptions: [
            { value: 'private choice', label: 'Private choice' },
          ],
        }),
    });
    const combo = nodeWithId(model, 'search');
    const list = nodeWithId(model, 'search-label');
    combo.attributes.role = 'combobox';
    combo.attributes['aria-controls'] = 'private-list';
    list.attributes.id = 'private-list';
    list.attributes.role = 'listbox';
    list.secret = true;

    const target = await targetFor(deps, model, 'search');
    sent.length = 0;
    const description = await describeActionTarget(deps, model, target);
    expect(description).toMatchObject({
      valueRedacted: true,
      optionsRedacted: true,
    });
    expect(description).not.toHaveProperty('value');
    expect(description).not.toHaveProperty('selectedOptions');
    expect(JSON.stringify(description)).not.toContain('private');
    const call = sent.find(
      (entry) => entry.params.functionDeclaration === DESCRIBE_FUNCTION,
    );
    expect(call?.params.arguments).toEqual([{ value: true }]);

    const listRef = model.registry.mintRef(list.identity);
    const listResolution = await resolveRefTarget(deps, listRef);
    if (listResolution.status !== 'found')
      throw new Error(listResolution.status);
    const describedList = await describeActionTarget(
      deps,
      model,
      listResolution.target,
    );
    expect(describedList).not.toHaveProperty('name');
  });

  it('is unavailable for a node that left its document or cannot be read', async () => {
    const detached = await setup('frames', {
      describe: () => ({ connected: false }),
    });
    const target = await targetFor(detached.deps, detached.model, 'before');
    expect(
      await describeActionTarget(detached.deps, detached.model, target),
    ).toBeUndefined();
    const garbage = await setup('frames', {
      describe: () => ({ connected: true, tagName: 7 }),
    });
    const other = await targetFor(garbage.deps, garbage.model, 'before');
    expect(
      await describeActionTarget(garbage.deps, garbage.model, other),
    ).toBeUndefined();
    const unresolvable = await setup('frames', { failResolveIn: 'host' });
    const third = await targetFor(
      unresolvable.deps,
      unresolvable.model,
      'before',
    );
    expect(
      await describeActionTarget(unresolvable.deps, unresolvable.model, third),
    ).toBeUndefined();
  });
});

describe('filling a resolved target (D8)', () => {
  it('runs the fill in the frame host world on the retained node', async () => {
    const { deps, model, sent } = await setup('frames', { fill: 'filled' });
    const target = await targetFor(deps, model, 'frame-name');
    sent.length = 0;
    expect(await fillActionTarget(deps, target, 'Ada')).toBe('filled');
    const call = sent.find(
      (entry) => entry.method === 'Runtime.callFunctionOn',
    );
    expect(call).toEqual({
      method: 'Runtime.callFunctionOn',
      params: {
        objectId: `world71:${target.identity.backendNodeId}`,
        functionDeclaration: FILL_FUNCTION,
        arguments: [{ value: 'Ada' }],
        userGesture: true,
        returnByValue: true,
        objectGroup: target.objectGroup,
      },
      sessionId: target.identity.sessionId,
    });
  });

  it('never writes once its signal aborts while the host world is being created', async () => {
    const { deps, model, sent } = await setup('frames', { fill: 'filled' });
    const target = await targetFor(deps, model, 'frame-name');
    sent.length = 0;
    // Hold the host world's creation, as a busy renderer would.
    let createWorld: () => void = () => undefined;
    const send = deps.send;
    const held: ActionTargetDeps = {
      ...deps,
      send: (method, params, sessionId) =>
        method === 'Page.createIsolatedWorld'
          ? new Promise((resolve, reject) => {
              createWorld = (): void => {
                send(method, params, sessionId).then(resolve, reject);
              };
            })
          : send(method, params, sessionId),
    };
    const controller = new AbortController();
    const fill = fillActionTarget(held, target, 'stale', controller.signal);
    await Promise.resolve();
    controller.abort();
    createWorld();
    await expect(fill).rejects.toThrow();
    expect(
      sent.some(
        (entry) =>
          entry.method === 'Runtime.callFunctionOn' &&
          entry.params.functionDeclaration === FILL_FUNCTION,
      ),
    ).toBe(false);
  });

  it('reports a node that is not fillable or gone', async () => {
    const refused = await setup('frames', { fill: 'not_fillable' });
    const target = await targetFor(refused.deps, refused.model, 'frame-button');
    expect(await fillActionTarget(refused.deps, target, 'x')).toBe(
      'not_fillable',
    );
    const odd = await setup('frames', { fill: 'something else' });
    const other = await targetFor(odd.deps, odd.model, 'frame-name');
    expect(await fillActionTarget(odd.deps, other, 'x')).toBe('target_stale');
    const gone = await setup('frames', { failResolveIn: 'host' });
    const third = await targetFor(gone.deps, gone.model, 'frame-name');
    expect(await fillActionTarget(gone.deps, third, 'x')).toBe('target_stale');
  });
});
