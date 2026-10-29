import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clickPoint,
  createRng,
  cursorPath,
  cursorTravelMs,
  evenPixels,
  expandFrameTimeline,
  typingDelays,
} from '../demo/demoMath.mjs';

test('createRng is deterministic per seed and stays in [0, 1)', () => {
  const first = createRng(7);
  const second = createRng(7);
  const values = Array.from({ length: 200 }, () => first());
  assert.deepEqual(
    values,
    Array.from({ length: 200 }, () => second()),
  );
  assert.ok(values.every((value) => value >= 0 && value < 1));
  const otherSeed = createRng(8);
  assert.notDeepEqual(
    values.slice(0, 5),
    Array.from({ length: 5 }, () => otherSeed()),
  );
});

test('cursorPath ends exactly on target with increasing timestamps', () => {
  const points = cursorPath(
    { x: 10, y: 20 },
    { x: 610, y: 420 },
    { durationMs: 480, rng: createRng(1) },
  );
  assert.equal(points.length, 30);
  assert.deepEqual(points.at(-1), { x: 610, y: 420, atMs: 480 });
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(points[index].atMs > points[index - 1].atMs);
  }
  // Curved, not a straight line: some point leaves the direct segment.
  const offLine = points.some((point) => {
    const expectedY = 20 + ((point.x - 10) / 600) * 400;
    return Math.abs(point.y - expectedY) > 5;
  });
  assert.ok(offLine);
});

test('cursorPath and travel time collapse to an instant move at pace 0', () => {
  assert.equal(cursorTravelMs(500, 0), 0);
  assert.deepEqual(
    cursorPath(
      { x: 0, y: 0 },
      { x: 50, y: 60 },
      {
        durationMs: 0,
        rng: createRng(1),
      },
    ),
    [{ x: 50, y: 60, atMs: 0 }],
  );
  assert.ok(cursorTravelMs(2_000, 1) <= 950);
  assert.ok(cursorTravelMs(1, 1) >= 320);
});

test('clickPoint stays inside small targets', () => {
  const rng = createRng(3);
  const box = { x: 100, y: 200, width: 12, height: 10 };
  for (let index = 0; index < 100; index += 1) {
    const point = clickPoint(box, rng);
    assert.ok(point.x >= box.x && point.x <= box.x + box.width);
    assert.ok(point.y >= box.y && point.y <= box.y + box.height);
  }
});

test('typingDelays add hesitation after punctuation and scale with pace', () => {
  const text = 'Hi, there.';
  const natural = typingDelays(text, { wpm: 60, pace: 1, rng: createRng(5) });
  assert.equal(natural.length, text.length);
  assert.ok(natural[2] > 200, 'comma pauses longer than a base keystroke');
  assert.deepEqual(
    typingDelays(text, { wpm: 60, pace: 0, rng: createRng(5) }),
    Array(text.length).fill(0),
  );
});

test('expandFrameTimeline holds each frame until the next and fills to the end', () => {
  const sequence = expandFrameTimeline(
    [
      { frame: 'a', timestamp: 100.2 },
      { frame: 'b', timestamp: 100.5 },
      { frame: 'c', timestamp: 100.51 },
      { frame: 'd', timestamp: 101 },
    ],
    { startSeconds: 100, endSeconds: 102, fps: 10 },
  );
  // 'a' also covers the 0.2s before the first frame; 'c' arrives within the
  // same output frame as 'b' and replaces it.
  assert.deepEqual(sequence, [
    { frame: 'a', repeat: 5 },
    { frame: 'c', repeat: 5 },
    { frame: 'd', repeat: 10 },
  ]);
  assert.equal(
    sequence.reduce((total, entry) => total + entry.repeat, 0),
    20,
  );
  assert.deepEqual(
    expandFrameTimeline([], { startSeconds: 0, endSeconds: 1, fps: 30 }),
    [],
  );
});

test('evenPixels rounds down to an even size', () => {
  assert.equal(evenPixels(2561), 2560);
  assert.equal(evenPixels(1600), 1600);
  assert.equal(evenPixels(1), 2);
});
