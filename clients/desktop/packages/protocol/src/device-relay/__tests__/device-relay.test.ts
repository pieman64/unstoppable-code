import {
  DEVICE_RELAY_DATA_FRAME_OVERHEAD_BYTES,
  DEVICE_RELAY_SUBPROTOCOL,
  decodeDeviceRelayDataFrame,
  deviceRelaySubprotocols,
  deviceRelayTokenFromSubprotocols,
  encodeDeviceRelayDataFrame,
  isDeviceId,
  parseDeviceRelayClientMessage,
  parseDeviceRelayServerMessage,
} from '../index';

const DEVICE_ID = 'AbCdEfGhIjKlMnOpQrSt-_';

describe('device relay contract', () => {
  it('round-trips data frames', () => {
    const payload = new Uint8Array([0, 1, 2, 255]);
    const frame = encodeDeviceRelayDataFrame(DEVICE_ID, payload);
    const decoded = decodeDeviceRelayDataFrame(frame);
    expect(decoded?.deviceId).toBe(DEVICE_ID);
    expect(Array.from(decoded?.payload ?? [])).toEqual([0, 1, 2, 255]);
  });

  it('rejects malformed frames and device IDs', () => {
    expect(isDeviceId('short')).toBe(false);
    expect(() =>
      encodeDeviceRelayDataFrame('bad id', new Uint8Array()),
    ).toThrow();
    expect(decodeDeviceRelayDataFrame(new Uint8Array([2, 0]))).toBeNull();
    expect(decodeDeviceRelayDataFrame(new Uint8Array([1, 30, 65]))).toBeNull();
  });

  it('parses control messages and ignores invalid ones', () => {
    expect(
      parseDeviceRelayServerMessage(
        JSON.stringify({ type: 'peer.offline', deviceId: DEVICE_ID }),
      ),
    ).toEqual({ type: 'peer.offline', deviceId: DEVICE_ID });
    expect(parseDeviceRelayServerMessage('{"type":"nope"}')).toBeNull();
    expect(parseDeviceRelayClientMessage('not json')).toBeNull();
  });

  it('states the data frame overhead exactly', () => {
    const frame = encodeDeviceRelayDataFrame(DEVICE_ID, new Uint8Array(10));
    expect(frame.byteLength - 10).toBe(DEVICE_RELAY_DATA_FRAME_OVERHEAD_BYTES);
  });

  it('carries the token as a subprotocol and reads exactly one back', () => {
    const offered = deviceRelaySubprotocols('abc.def');
    expect(offered[0]).toBe(DEVICE_RELAY_SUBPROTOCOL);
    expect(deviceRelayTokenFromSubprotocols(offered)).toBe('abc.def');
    // The relay protocol must be offered, with exactly one non-empty token.
    expect(deviceRelayTokenFromSubprotocols(offered.slice(1))).toBeNull();
    expect(
      deviceRelayTokenFromSubprotocols([...offered, offered[1] ?? '']),
    ).toBeNull();
    expect(
      deviceRelayTokenFromSubprotocols([
        DEVICE_RELAY_SUBPROTOCOL,
        'canopy-relay-token.',
      ]),
    ).toBeNull();
  });
});
