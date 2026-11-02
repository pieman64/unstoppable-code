import { ChatChildDeleteFence } from '../lib/chat-child-delete-fence';

it('fences old generation work and waits for admitted work', async () => {
  const fence = new ChatChildDeleteFence();
  const work = fence.acquire('parent');
  expect(work).toBeDefined();
  let completed = false;
  const retirement = fence.retire('parent').then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  expect(fence.acquire('parent')).toBeUndefined();
  expect(fence.isDeleted('parent', work?.generation)).toBe(true);
  work?.release();
  await retirement;
  const next = fence.restore('parent');
  expect(next).toBeGreaterThan(work?.generation ?? -1);
  expect(fence.isDeleted('parent', work?.generation)).toBe(true);
  expect(fence.acquire('parent')?.generation).toBe(next);
});
