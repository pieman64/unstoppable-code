import { pointerRecording } from '../pointer-recording';

it('records each actual wheel and script fallback in order, not an aggregated requested delta', () => {
  const step = pointerRecording({
    action: 'scroll',
    page: true,
    scroll: {
      inputMode: 'direct',
      warnings: [],
      deltas: [{ dx: 0, dy: 100 }],
      operations: [
        { kind: 'wheel', dx: 0, dy: 100, point: { x: 40, y: 60 } },
        { kind: 'script', dx: 0, dy: 100 },
      ],
    },
  });
  expect(step.playwright).toBe(
    [
      'await page.mouse.move(40, 60);',
      'await page.mouse.wheel(0, 100);',
      "await page.evaluate(() => (document.scrollingElement || document.documentElement).scrollBy({ left: 0, top: 100, behavior: 'instant' }));",
    ].join('\n'),
  );
});

it('records a to-text scroll as a scroll to the text, not to the element around it', () => {
  const step = pointerRecording({
    action: 'scroll',
    locator: "page.locator('#log')",
    text: 'line 60',
  });
  // The element comes into view first, with any frames around it. It can be
  // far taller than the viewport and already in view, where that does not
  // move, so the words are then centred inside it.
  expect(step.playwright).toMatch(
    /^await page\.locator\('#log'\)\.scrollIntoViewIfNeeded\(\);\nawait page\.locator\('#log'\)\.evaluate\(\(element, text\) => \{[\s\S]+\}, "line 60"\);$/,
  );
  expect(step.playwright).toContain('createRange');
  // Without a replayable locator there is nothing to scroll from.
  expect(
    pointerRecording({ action: 'scroll', text: 'line 60' }).playwright,
  ).toBe('// This action has no replayable locator or point.');
});

it('records a hover on an element as a scroll to it and a move measured from its box', () => {
  // The action scrolled the element into view before it measured the
  // point; a bare viewport point replays over whatever is there instead.
  const step = pointerRecording({
    action: 'hover',
    locator: "page.locator('#menu')",
    point: { x: 70, y: 320 },
    origin: { x: 20, y: 300.25 },
  });
  expect(step.playwright).toBe(
    [
      '{',
      "  const source = page.locator('#menu');",
      '  await source.scrollIntoViewIfNeeded();',
      '  const box = await source.boundingBox();',
      "  if (!box) throw new Error('The hover target is not rendered.');",
      '  await page.mouse.move(box.x + 50, box.y + 19.75);',
      '}',
    ].join('\n'),
  );
  // A hover at a point scrolls nothing, so it replays at that point.
  expect(
    pointerRecording({ action: 'hover', point: { x: 70, y: 320 } }).playwright,
  ).toBe('await page.mouse.move(70, 320);');
});

it('records a drag from its source element, with the destination as a distance from the start', () => {
  const step = pointerRecording({
    action: 'drag',
    locator: "page.locator('#card')",
    point: { x: 70, y: 320 },
    origin: { x: 20, y: 300 },
    destination: { x: 270, y: 290 },
    steps: 4,
    modifiers: ['Shift'],
  });
  expect(step.playwright).toBe(
    [
      '{',
      "  const source = page.locator('#card');",
      '  await source.scrollIntoViewIfNeeded();',
      '  const box = await source.boundingBox();',
      "  if (!box) throw new Error('The drag source is not rendered.');",
      '  const x = box.x + 50, y = box.y + 20;',
      '  await page.mouse.move(x, y);',
      '  await page.keyboard.down("Shift");',
      '  await page.mouse.down();',
      '  await page.mouse.move(x + 200, y - 30, { steps: 4 });',
      '  await page.mouse.up();',
      '  await page.keyboard.up("Shift");',
      '}',
    ].join('\n'),
  );
});

it('says so when an element source has no locator to replay its scroll from', () => {
  // A source in a closed shadow root: the point is all there is.
  const step = pointerRecording({
    action: 'hover',
    point: { x: 70, y: 320 },
    unlocated: true,
  });
  expect(step.playwright).toBe(
    [
      '// The element has no replayable locator. This replays at the point the action used, without its scroll into view.',
      'await page.mouse.move(70, 320);',
    ].join('\n'),
  );
});
