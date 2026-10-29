import { netstatShowsListener } from '../listener-owner';

const ENGLISH = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1032
  TCP    127.0.0.1:41000        0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:41000        127.0.0.1:52000        ESTABLISHED     4242
  TCP    127.0.0.1:52000        127.0.0.1:41000        ESTABLISHED     777
`;

// netstat translates its state column; German Windows prints ABHÖREN.
const GERMAN = `
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  TCP    127.0.0.1:41000        0.0.0.0:0              ABHÖREN          4242
  TCP    [::1]:41001            [::]:0                 ABHÖREN          4243
`;

describe('netstatShowsListener', () => {
  it('finds the process listening on a port', () => {
    expect(netstatShowsListener(ENGLISH, 4242, 41000)).toBe(true);
    expect(netstatShowsListener(ENGLISH, 777, 41000)).toBe(false);
    expect(netstatShowsListener(ENGLISH, 4242, 4100)).toBe(false);
  });

  it('does not depend on the language Windows prints states in', () => {
    expect(netstatShowsListener(GERMAN, 4242, 41000)).toBe(true);
    expect(netstatShowsListener(GERMAN, 4243, 41001)).toBe(true);
  });

  it('does not take a connection to the port for its listener', () => {
    expect(
      netstatShowsListener(
        '  TCP    127.0.0.1:52000        127.0.0.1:41000        ESTABLISHED     777',
        777,
        41000,
      ),
    ).toBe(false);
  });
});
