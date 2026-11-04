import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHeapSnapshot } from 'node:v8';
import { describeRetainerPath } from './helpers/heap-retainer-path';

const ROOT = '__heapRetainerPathTestRoot';
let markerCount = 0;

describe('describeRetainerPath', () => {
  let directory: string;
  // Jest keeps replaced globals until the file ends, so each test marks anew.
  let MARKER: string;

  beforeEach(() => {
    markerCount += 1;
    MARKER = `__heapRetainerPathTestMarker${String(markerCount)}`;
    directory = mkdtempSync(join(tmpdir(), 'heap-retainer-path-'));
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, ROOT);
    rmSync(directory, { recursive: true, force: true });
  });

  // Fixtures are built in their own frames so the test's stack holds none.
  function holdThroughGlobal(): void {
    Reflect.set(globalThis, ROOT, { holder: { [MARKER]: true } });
  }

  function holdThroughLiveWeakMap(): void {
    const map = new WeakMap<object, object>();
    const key = {};
    map.set(key, { [MARKER]: true });
    Reflect.set(globalThis, ROOT, { map, key });
  }

  function holdKeyAndValueOfUnheldWeakMap(): void {
    const key = {};
    const map = new WeakMap<object, object>();
    const value = { [MARKER]: true, map };
    map.set(key, value);
    Reflect.set(globalThis, ROOT, { key, a: { b: { c: value } } });
  }

  function snapshotPath(name: string): string {
    return describeRetainerPath(
      writeHeapSnapshot(join(directory, `${name}.heapsnapshot`)),
      MARKER,
    );
  }

  it('names each strong step from a global to the marked object', () => {
    holdThroughGlobal();

    const path = snapshotPath('held');

    expect(path).toContain(`.${ROOT} -> object Object`);
    expect(path).toContain('.holder -> object Object');
  }, 60_000);

  it('follows a WeakMap entry whose key and map are both alive', () => {
    holdThroughLiveWeakMap();

    const path = snapshotPath('live-weak-map');

    expect(path).toContain(`.${ROOT} -> object Object`);
    expect(path).not.toContain('unreachable');
  }, 60_000);

  it('does not follow a WeakMap entry whose map only its value holds', () => {
    holdKeyAndValueOfUnheldWeakMap();

    const path = snapshotPath('cyclic-weak-map');

    expect(path).toContain('.c -> object Object');
    expect(path).not.toContain('part of key');
  }, 60_000);
});
