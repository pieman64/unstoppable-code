import { cancelDocumentCommands, documentCommand } from '../document-command';

describe('page model commands bound to the main document', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('settles with the command and forgets it', async () => {
    const owner: { documentCommands?: Set<(error: Error) => void> } = {};
    await expect(
      documentCommand(owner, 'probe', Promise.resolve(3), undefined, 1_000),
    ).resolves.toBe(3);
    expect(owner.documentCommands?.size).toBe(0);
  });

  it('is rejected when the document is replaced, when aborted, or after its timeout', async () => {
    jest.useFakeTimers();
    const owner: { documentCommands?: Set<(error: Error) => void> } = {};
    const never = new Promise<never>(() => undefined);
    const replaced = documentCommand(owner, 'fill', never, undefined, 15_000);
    expect(owner.documentCommands?.size).toBe(1);
    cancelDocumentCommands(
      owner,
      new Error('Browser main-frame document was replaced.'),
    );
    await expect(replaced).rejects.toThrow('document was replaced');
    const controller = new AbortController();
    const aborted = documentCommand(
      owner,
      'fill',
      never,
      controller.signal,
      15_000,
    );
    controller.abort(new Error('cancelled'));
    await expect(aborted).rejects.toThrow('cancelled');
    const timed = documentCommand(owner, 'describe', never, undefined, 15_000);
    const settled = expect(timed).rejects.toThrow(
      'Browser command timed out: describe',
    );
    await jest.advanceTimersByTimeAsync(15_000);
    await settled;
    expect(owner.documentCommands?.size).toBe(0);
  });
});
