import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { startDemo } from './demo/demoDirector.mjs';

test.use({ viewport: { width: 400, height: 300 } });

test('drag rejects endpoints that cannot remain actionable after scrolling', async ({
  page,
}) => {
  await page.setContent(`
    <div style="height: 160px; overflow: auto; position: relative">
      <div id="from" style="height: 40px">Source</div>
      <div style="height: 360px"></div>
      <div id="to" style="height: 40px">Destination</div>
    </div>
    <script>
      window.pressedTarget = null;
      document.addEventListener('mousedown', (event) => {
        window.pressedTarget = event.target.id;
      });
    </script>
  `);
  const demo = await startDemo(page, { pace: 0, record: false });

  await assert.rejects(
    demo.drag(page.locator('#from'), page.locator('#to'), { after: 0 }),
    /Drag endpoints cannot remain actionable together/,
  );
  assert.equal(await page.evaluate(() => window.pressedTarget), null);
});

test('drag remeasures both endpoints after destination scrolling', async ({
  page,
}) => {
  await page.setContent(`
    <div style="height: 160px; overflow: auto">
      <div style="height: 70px"></div>
      <div id="from" style="height: 40px">Source</div>
      <div style="height: 80px"></div>
      <div id="to" style="height: 40px">Destination</div>
    </div>
    <script>
      window.pressedTarget = null;
      document.addEventListener('mousedown', (event) => {
        window.pressedTarget = event.target.id;
      });
    </script>
  `);
  const demo = await startDemo(page, { pace: 0, record: false });

  await demo.drag(page.locator('#from'), page.locator('#to'), { after: 0 });
  assert.equal(await page.evaluate(() => window.pressedTarget), 'from');
});
