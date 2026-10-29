import { isNonPublicIpAddress } from '../network-address';

describe('IPv4-embedded IPv6 address policy', () => {
  it.each([
    ['127.0.0.1', '7f00:1', true],
    ['10.0.0.1', 'a00:1', true],
    ['172.16.0.1', 'ac10:1', true],
    ['192.168.0.1', 'c0a8:1', true],
    ['169.254.169.254', 'a9fe:a9fe', true],
    ['8.8.8.8', '808:808', false],
  ] as const)(
    'classifies embedded %s in dotted and hex forms',
    (dotted, hex, expected): void => {
      for (const prefix of [
        '::ffff:',
        '0:0:0:0:0:ffff:',
        '::',
        '0:0:0:0:0:0:',
      ]) {
        for (const suffix of [dotted, hex]) {
          const address = `${prefix}${suffix}`;
          expect({ address, nonPublic: isNonPublicIpAddress(address) }).toEqual(
            { address, nonPublic: expected },
          );
          expect({
            address,
            nonPublic: isNonPublicIpAddress(`[${address}]`),
          }).toEqual({ address, nonPublic: expected });
        }
      }
    },
  );
});
