// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  classifyAddress,
  evaluateLeasedUrl,
  isAllowedAddressClass,
  normalizeOrigin,
} from './address-policy.mjs';

describe('classifyAddress', () => {
  /** @type {Array<[string, string]>} */
  const cases = [
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['::1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['172.15.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.128.0.1', 'public'],
    ['169.254.1.1', 'link-local'],
    ['fe80::1', 'link-local'],
    ['febf::1', 'link-local'],
    ['169.254.169.254', 'metadata'],
    ['fd00:ec2::254', 'metadata'],
    ['FD00:EC2:0:0:0:0:0:254', 'metadata'],
    ['fc00::1', 'unique-local'],
    ['fd12:3456::1', 'unique-local'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['::', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['ff02::1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['192.0.2.1', 'synthetic-public'],
    ['198.51.100.7', 'synthetic-public'],
    ['203.0.113.20', 'synthetic-public'],
    ['2001:db8::1', 'synthetic-public'],
    ['2001:DB8:abcd::1', 'synthetic-public'],
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['not-an-ip', 'invalid'],
    ['', 'invalid'],
    ['256.1.1.1', 'invalid'],
    ['127.1', 'invalid'],
    ['example.com', 'invalid'],
  ];
  for (const [ip, expected] of cases) {
    test(`${JSON.stringify(ip)} -> ${expected}`, () => {
      assert.equal(classifyAddress(ip), expected);
    });
  }

  test('IPv4-mapped IPv6 classifies as the embedded IPv4 (both textual forms, any case)', () => {
    assert.equal(classifyAddress('::ffff:127.0.0.1'), 'loopback');
    assert.equal(classifyAddress('::FFFF:127.0.0.1'), 'loopback');
    assert.equal(classifyAddress('::ffff:7f00:1'), 'loopback');
    assert.equal(classifyAddress('::FfFf:7F00:0001'), 'loopback');
    assert.equal(classifyAddress('0:0:0:0:0:ffff:7f00:1'), 'loopback');
    assert.equal(classifyAddress('::ffff:10.0.0.1'), 'private');
    assert.equal(classifyAddress('::ffff:a00:1'), 'private');
    assert.equal(classifyAddress('::ffff:169.254.169.254'), 'metadata');
    assert.equal(classifyAddress('::ffff:a9fe:a9fe'), 'metadata');
    assert.equal(classifyAddress('::ffff:203.0.113.5'), 'synthetic-public');
    assert.equal(classifyAddress('::ffff:8.8.8.8'), 'public');
    assert.equal(classifyAddress('::ffff:0.0.0.0'), 'unspecified');
    assert.equal(classifyAddress('::ffff:255.255.255.255'), 'broadcast');
  });

  test('zone ids do not change the class', () => {
    assert.equal(classifyAddress('fe80::1%en0'), 'link-local');
  });

  test('non-strings are invalid', () => {
    // @ts-expect-error deliberate misuse
    assert.equal(classifyAddress(undefined), 'invalid');
  });
});

describe('isAllowedAddressClass', () => {
  test('only public and synthetic-public pass', () => {
    assert.equal(isAllowedAddressClass('public'), true);
    assert.equal(isAllowedAddressClass('synthetic-public'), true);
    for (const c of [
      'loopback',
      'private',
      'link-local',
      'metadata',
      'unique-local',
      'cgnat',
      'unspecified',
      'multicast',
      'broadcast',
      'reserved',
      'invalid',
    ]) {
      assert.equal(isAllowedAddressClass(c), false, c);
    }
  });
});

describe('normalizeOrigin', () => {
  test('ws/wss map to http/https', () => {
    assert.equal(normalizeOrigin('ws://127.0.0.1:5'), 'http://127.0.0.1:5');
    assert.equal(
      normalizeOrigin('ws://127.0.0.1:5'),
      normalizeOrigin('http://127.0.0.1:5/path?q'),
    );
    assert.equal(normalizeOrigin('wss://example.test'), 'https://example.test');
    assert.equal(
      normalizeOrigin('ws://example.test:80'),
      normalizeOrigin('http://example.test'),
    );
    assert.equal(
      normalizeOrigin('wss://example.test:443/x'),
      normalizeOrigin('https://example.test'),
    );
  });
  test('ports are significant', () => {
    assert.notEqual(
      normalizeOrigin('http://127.0.0.1:5'),
      normalizeOrigin('http://127.0.0.1:6'),
    );
  });
  test('opaque and invalid inputs return null', () => {
    assert.equal(normalizeOrigin('about:blank'), null);
    assert.equal(normalizeOrigin('data:text/plain,hi'), null);
    assert.equal(normalizeOrigin('file:///etc/passwd'), null);
    assert.equal(normalizeOrigin('nope'), null);
    assert.equal(normalizeOrigin('blob:null/abc'), null);
  });
  test('blob urls reduce to the inner origin', () => {
    assert.equal(
      normalizeOrigin('blob:http://127.0.0.1:5/uuid'),
      'http://127.0.0.1:5',
    );
  });
});

describe('evaluateLeasedUrl', () => {
  const exceptionOrigin = 'http://127.0.0.1:4100';

  test('unparsable -> invalid-url', () => {
    const d = evaluateLeasedUrl('not a url');
    assert.deepEqual(d, {
      allow: false,
      reason: 'invalid-url',
      host: null,
      hostKind: 'none',
    });
  });

  test('about and data', () => {
    assert.equal(evaluateLeasedUrl('about:blank').reason, 'about');
    assert.equal(evaluateLeasedUrl('about:blank').allow, true);
    assert.equal(evaluateLeasedUrl('about:srcdoc').allow, true);
    assert.equal(evaluateLeasedUrl('about:config').allow, false);
    const data = evaluateLeasedUrl('data:text/html,<h1>x</h1>');
    assert.equal(data.allow, true);
    assert.equal(data.reason, 'data-no-network');
  });

  test('dangerous and custom schemes are denied', () => {
    for (const u of [
      'file:///etc/passwd',
      'chrome://settings',
      'chrome-extension://abc/x.html',
      'javascript:alert(1)',
      'ftp://example.test/',
      'devtools://devtools/bundled/x.html',
      'canopy-app://internal',
      'view-source:http://example.test/',
    ]) {
      const d = evaluateLeasedUrl(u, { exceptionOrigin });
      assert.equal(d.allow, false, u);
      assert.equal(d.reason, 'scheme-denied', u);
    }
  });

  test('credentials in URL are denied', () => {
    assert.equal(
      evaluateLeasedUrl('http://user:pw@example.test/').reason,
      'credentials-in-url',
    );
    assert.equal(
      evaluateLeasedUrl('https://user@example.test/').reason,
      'credentials-in-url',
    );
    // Credentials are rejected even when the origin would otherwise be excepted.
    assert.equal(
      evaluateLeasedUrl('http://u:p@127.0.0.1:4100/', { exceptionOrigin })
        .allow,
      false,
    );
  });

  test('loopback literals in every encoding Chromium canonicalises are denied', () => {
    for (const u of [
      'http://127.0.0.1/',
      'http://0x7f000001/',
      'http://2130706433/',
      'http://127.1/',
      'http://%31%32%37.0.0.1/',
      'http://0177.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:7f00:1]/',
    ]) {
      const d = evaluateLeasedUrl(u);
      assert.equal(d.allow, false, u);
      assert.equal(d.reason, 'address-class:loopback', u);
      assert.equal(d.hostKind, 'ip', u);
    }
    assert.equal(evaluateLeasedUrl('http://0x7f000001/').host, '127.0.0.1');
    assert.equal(evaluateLeasedUrl('http://[::1]:8080/').host, '::1');
  });

  test('other non-public literals are denied with their class', () => {
    assert.equal(
      evaluateLeasedUrl('http://169.254.169.254/latest/meta-data').reason,
      'address-class:metadata',
    );
    assert.equal(
      evaluateLeasedUrl('http://[fd00:ec2::254]/').reason,
      'address-class:metadata',
    );
    assert.equal(
      evaluateLeasedUrl('http://10.0.0.5/').reason,
      'address-class:private',
    );
    assert.equal(
      evaluateLeasedUrl('http://192.168.0.1/').reason,
      'address-class:private',
    );
    assert.equal(
      evaluateLeasedUrl('http://100.64.1.1/').reason,
      'address-class:cgnat',
    );
    assert.equal(
      evaluateLeasedUrl('http://[fe80::1]/').reason,
      'address-class:link-local',
    );
    assert.equal(
      evaluateLeasedUrl('http://[fc00::1]/').reason,
      'address-class:unique-local',
    );
    assert.equal(
      evaluateLeasedUrl('http://0.0.0.0/').reason,
      'address-class:unspecified',
    );
    assert.equal(
      evaluateLeasedUrl('ws://224.0.0.1/').reason,
      'address-class:multicast',
    );
  });

  test('public and synthetic-public literals are allowed', () => {
    const pub = evaluateLeasedUrl('https://8.8.8.8/');
    assert.deepEqual(pub, {
      allow: true,
      reason: 'address-class:public',
      host: '8.8.8.8',
      hostKind: 'ip',
    });
    const syn = evaluateLeasedUrl('http://203.0.113.10/');
    assert.equal(syn.allow, true);
    assert.equal(syn.reason, 'address-class:synthetic-public');
    assert.equal(evaluateLeasedUrl('http://[2001:db8::1]/').allow, true);
  });

  test('localhost names are denied', () => {
    for (const u of [
      'http://localhost/',
      'http://LOCALHOST:3000/',
      'http://foo.localhost/',
      'http://localhost./',
    ]) {
      const d = evaluateLeasedUrl(u);
      assert.equal(d.allow, false, u);
      assert.equal(d.reason, 'localhost-name', u);
      assert.equal(d.hostKind, 'name', u);
    }
    assert.equal(evaluateLeasedUrl('http://notlocalhost.test/').allow, true);
  });

  test('ordinary names are deferred to the gateway', () => {
    const d = evaluateLeasedUrl('https://Example.TEST/path');
    assert.deepEqual(d, {
      allow: true,
      reason: 'name-needs-resolved-address-check',
      host: 'example.test',
      hostKind: 'name',
    });
    assert.equal(
      evaluateLeasedUrl('wss://rebind.s03.test/ws').hostKind,
      'name',
    );
  });

  test('blob: evaluates the inner origin', () => {
    assert.equal(
      evaluateLeasedUrl('blob:http://127.0.0.1:9/uuid').reason,
      'address-class:loopback',
    );
    assert.equal(
      evaluateLeasedUrl('blob:https://example.test/uuid').reason,
      'name-needs-resolved-address-check',
    );
    assert.equal(evaluateLeasedUrl('blob:null/uuid').allow, false);
    assert.equal(
      evaluateLeasedUrl('blob:null/uuid').reason,
      'blob-opaque-origin',
    );
    assert.equal(
      evaluateLeasedUrl('blob:http://127.0.0.1:4100/uuid', { exceptionOrigin })
        .allow,
      true,
    );
  });

  test('exception origin matches the exact origin including port', () => {
    const ok = evaluateLeasedUrl('http://127.0.0.1:4100/page?x=1', {
      exceptionOrigin,
    });
    assert.equal(ok.allow, true);
    assert.equal(ok.reason, 'fixture-origin-exception');
    // Different port on the same host is not excepted.
    const other = evaluateLeasedUrl('http://127.0.0.1:4101/', {
      exceptionOrigin,
    });
    assert.equal(other.allow, false);
    assert.equal(other.reason, 'address-class:loopback');
    // Different scheme (https vs http) is a different origin.
    assert.equal(
      evaluateLeasedUrl('https://127.0.0.1:4100/', { exceptionOrigin }).allow,
      false,
    );
    // Different host, same port.
    assert.equal(
      evaluateLeasedUrl('http://localhost:4100/', { exceptionOrigin }).allow,
      false,
    );
    // No exception configured.
    assert.equal(evaluateLeasedUrl('http://127.0.0.1:4100/').allow, false);
  });

  test('ws and http origins are equivalent for exception matching', () => {
    assert.equal(
      evaluateLeasedUrl('ws://127.0.0.1:4100/socket', { exceptionOrigin })
        .allow,
      true,
    );
    assert.equal(
      evaluateLeasedUrl('ws://127.0.0.1:4100/socket', { exceptionOrigin })
        .reason,
      'fixture-origin-exception',
    );
    assert.equal(
      evaluateLeasedUrl('http://127.0.0.1:4100/', {
        exceptionOrigin: 'ws://127.0.0.1:4100',
      }).allow,
      true,
    );
    assert.equal(
      evaluateLeasedUrl('wss://127.0.0.1:4100/', { exceptionOrigin }).allow,
      false,
    );
  });

  test('encoded loopback forms match the exception only when canonical origin is equal', () => {
    assert.equal(
      evaluateLeasedUrl('http://0x7f000001:4100/', { exceptionOrigin }).allow,
      true,
    );
    assert.equal(
      evaluateLeasedUrl('http://2130706433:4100/', { exceptionOrigin }).allow,
      true,
    );
    assert.equal(
      evaluateLeasedUrl('http://0x7f000001:4101/', { exceptionOrigin }).allow,
      false,
    );
  });

  test('deniedOrigins take precedence over the exception', () => {
    const d = evaluateLeasedUrl('http://127.0.0.1:4100/', {
      exceptionOrigin,
      deniedOrigins: ['http://127.0.0.1:4100'],
    });
    assert.equal(d.allow, false);
    assert.equal(d.reason, 'denied-origin');
    // ws form of a denied http origin is denied too.
    assert.equal(
      evaluateLeasedUrl('ws://127.0.0.1:4100/', {
        exceptionOrigin,
        deniedOrigins: ['http://127.0.0.1:4100'],
      }).reason,
      'denied-origin',
    );
  });

  test('deniedOrigins deny otherwise-allowed names and public addresses', () => {
    const name = evaluateLeasedUrl('https://bank.example.test/', {
      deniedOrigins: ['https://bank.example.test'],
    });
    assert.equal(name.allow, false);
    assert.equal(name.reason, 'denied-origin');
    assert.equal(name.hostKind, 'name');
    const ip = evaluateLeasedUrl('http://203.0.113.10:8080/', {
      deniedOrigins: ['http://203.0.113.10:8080'],
    });
    assert.equal(ip.reason, 'denied-origin');
    // A different port is not denied.
    assert.equal(
      evaluateLeasedUrl('http://203.0.113.10:8081/', {
        deniedOrigins: ['http://203.0.113.10:8080'],
      }).allow,
      true,
    );
  });
});
