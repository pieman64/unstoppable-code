import * as transport from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';

describe('@canopy/core-transport alias', () => {
  it('resolves the root and the browser-safe types subpath', async () => {
    const { client, server } = await transport.createInMemoryFramedPair();
    const connections: CanopyFramedConnection[] = [client, server];
    expect(connections.map((connection) => connection.signal.aborted)).toEqual([
      false,
      false,
    ]);
    client.close();
  });
});
