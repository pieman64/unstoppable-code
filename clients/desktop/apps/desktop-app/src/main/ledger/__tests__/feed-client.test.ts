import type {
  CanopyCloudAuthenticatedRequestInit,
  CanopyCloudCredentialContext,
} from '../../canopy-cloud/client';
import { createLedgerMirrorReader } from '../feed-client';

const ACCOUNT_A = '00000000-0000-4000-8000-0000000000c1';
const ACCOUNT_B = '00000000-0000-4000-8000-0000000000c2';
const ENTRY_ID = '00000000-0000-4000-8000-000000000101';

function credentials(
  accountId: string,
  apiKey: string,
): CanopyCloudCredentialContext {
  return {
    baseUrl: 'https://cloud.example.test',
    apiKey,
    account: {
      id: accountId,
      name: 'Fixture account',
      email: 'fixture@example.test',
      role: 'DEVELOPER',
    },
  };
}

interface SentRequest {
  readonly pathname: string;
  readonly init: CanopyCloudAuthenticatedRequestInit;
}

describe('createLedgerMirrorReader', () => {
  it('reads as the account it is asked for, with exactly its credentials', async () => {
    const sent: SentRequest[] = [];
    const reader = createLedgerMirrorReader(
      (pathname, init) => {
        sent.push({ pathname, init });
        return Promise.resolve({
          entries: [],
          actors: [],
          nextCursor: null,
          hasMore: false,
        });
      },
      () => Promise.resolve(credentials(ACCOUNT_A, 'key-a')),
    );

    const result = await reader.search({ audience: 'mine' }, ACCOUNT_A);

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.init.credentialContext?.apiKey).toBe('key-a');
  });

  it('sends nothing for an account that is no longer the one signed in', async () => {
    const sent: SentRequest[] = [];
    const request = (
      pathname: string,
      init: CanopyCloudAuthenticatedRequestInit,
    ): Promise<unknown> => {
      sent.push({ pathname, init });
      return Promise.resolve({});
    };
    // Another account signed in after the read was asked for.
    const switched = createLedgerMirrorReader(request, () =>
      Promise.resolve(credentials(ACCOUNT_B, 'key-b')),
    );
    const signedOut = createLedgerMirrorReader(request, () =>
      Promise.resolve(null),
    );

    expect(await switched.search({ audience: 'mine' }, ACCOUNT_A)).toEqual({
      ok: false,
      failure: 'account_changed',
    });
    expect(await switched.getEntry(ENTRY_ID, {}, ACCOUNT_A)).toEqual({
      ok: false,
      failure: 'account_changed',
    });
    expect(await signedOut.search({ audience: 'mine' }, ACCOUNT_A)).toEqual({
      ok: false,
      failure: 'account_changed',
    });
    expect(sent).toEqual([]);
  });
});
