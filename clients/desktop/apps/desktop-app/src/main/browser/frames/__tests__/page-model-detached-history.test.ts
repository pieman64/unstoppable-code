/** @jest-environment jsdom */
import {
  decodeTrackerAnswer,
  decodeTrackerSummary,
  isolatedTrackerSource,
  mainWorldTrackerSource,
} from '../trackers';
import { buildPageModel } from '../page-model';
import { projectInputSnapshot, projectInspect } from '../projections';
import { loadRecording, recordedDeps } from './fixtures/recorded-cdp';

const KEY = '__canopyPageModelTracker_detached';

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

it.each(['open', 'closed', 'light'] as const)(
  'withholds a later-task detached reveal in %s from snapshot and inspect (S7)',
  async (scope) => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const view = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!view || !doc) throw new Error('No realm');
    try {
      doc.documentElement.remove();
      Object.defineProperty(view.location, 'ancestorOrigins', {
        value: scope === 'light' ? ['https://parent.test'] : [],
      });
      const evaluate: unknown = Reflect.get(view, 'eval');
      if (typeof evaluate !== 'function') throw new Error('No eval');
      Reflect.apply(evaluate, view, [
        scope === 'light'
          ? isolatedTrackerSource(KEY)
          : mainWorldTrackerSource(KEY, { documents: 'top' }),
      ]);
      const html = doc.createElement('html');
      doc.append(html);
      html.innerHTML = '<head></head><body><div></div></body>';
      const host = doc.body.querySelector('div');
      if (!host) throw new Error('No host');
      const root =
        scope === 'light' ? host : host.attachShadow({ mode: scope });
      root.innerHTML = '<input type="password">';
      const input = root.querySelector('input');
      if (!input) throw new Error('No input');
      const id = scope === 'light' ? 'frame-plain' : `${scope}-plain`;
      const seed =
        scope === 'light' ? 'frame plain value' : `${scope} plain value`;
      input.value = seed;
      await nextTask();
      input.remove();
      await nextTask();
      input.type = 'text';
      await nextTask();
      root.append(input);
      const resolver: unknown = Reflect.get(view, KEY);
      if (typeof resolver !== 'function') throw new Error('No resolver');
      // Feed the actual production holder's answer and summary into the model,
      // not a predetermined "was". No recording or parity expectation changes.
      const history = decodeTrackerAnswer(
        Reflect.apply(resolver, view, [input]),
        1,
      );
      const summary = decodeTrackerSummary(Reflect.apply(resolver, view, []));
      if (!history || !summary) throw new Error('Bad holder answer');
      const recording = loadRecording('trackers');
      const base = recordedDeps(recording);
      const model = await buildPageModel(
        recordedDeps(recording, {
          controlHistory: (_frameId, _sessionId, holderScope, ids) =>
            Promise.resolve(
              ids.map(() =>
                holderScope === (scope === 'light' ? 'light' : 'shadow')
                  ? history.statuses[0]
                  : 'unknown',
              ),
            ),
          controlHistorySummary: (_frameId, _sessionId, holderScope) =>
            Promise.resolve(
              holderScope === (scope === 'light' ? 'light' : 'shadow')
                ? summary.remembers
                  ? 'some'
                  : 'none'
                : 'none',
            ),
          isPasswordEverSeen: (frameId, sessionId, ids, purpose) =>
            purpose === 'remembered'
              ? Promise.resolve(ids.map(() => false))
              : base.isPasswordEverSeen(frameId, sessionId, ids),
        }),
      );
      const node = model.nodes.find(
        (candidate) => candidate.attributes.id === id,
      );
      if (!node) throw new Error(`No modeled ${id}`);
      const snapshot = projectInputSnapshot(
        model,
        { browserId: 'detached', limit: 100 },
        { browserId: 'detached', url: '', title: '' },
      );
      const row = snapshot.inputs.find(
        (candidate) => candidate.ref === model.registry.mintRef(node.identity),
      );
      expect(row).toMatchObject({ valueRedacted: true });
      expect(row?.value).toBeUndefined();
      const inspect = await projectInspect(model, node.identity, {
        enrich: () => Promise.resolve(null),
      });
      expect(JSON.stringify([snapshot, inspect])).not.toContain(seed);
      expect(node.secret).toBe(true);
    } finally {
      frame.remove();
    }
  },
);
