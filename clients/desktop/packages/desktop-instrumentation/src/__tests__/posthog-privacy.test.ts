import { redactText } from '../privacy';
import {
  POSTHOG_PROPERTY_DENYLIST,
  sanitizePostHogEvent,
} from '../posthog-privacy';

const TOKEN = `ghp_${'A'.repeat(36)}`;
const EMAIL = 'alice@example.com';
const CHAT = 'Please review my confidential acquisition proposal.';
const INSTALL =
  'file:///Users/alice/Applications/App.app/Contents/Resources/app.asar/out/renderer/index.html';

describe('PostHog outbound privacy', () => {
  it('retains only validated domain metadata, including nested person properties', () => {
    const result = sanitizePostHogEvent({
      properties: {
        email_domain: 'UnstoppableDomains.com',
        $set: { email_domain: 'private@unstoppabledomains.com' },
        context: { email_domain: { email: EMAIL } },
      },
      $set: { email_domain: 'example.test' },
    });
    expect(result).toEqual({
      properties: {
        email_domain: 'unstoppabledomains.com',
        $set: { email_domain: null },
        context: { email_domain: null },
      },
      $set: { email_domain: 'example.test' },
    });
    expect(sanitizePostHogEvent(result)).toEqual(result);
  });

  it('drops noncanonical email domain property names at every depth', () => {
    expect(
      sanitizePostHogEvent({
        properties: {
          email_domain: 'Example.test',
          emailDomain: 'example.test',
          'email-domain': 'example.test',
          $set: { emailDomain: 'example.test', email_domain: 'Example.test' },
        },
        $set: { 'email-domain': 'example.test', email_domain: 'Example.test' },
      }),
    ).toEqual({
      properties: {
        email_domain: 'example.test',
        $set: { email_domain: 'example.test' },
      },
      $set: { email_domain: 'example.test' },
    });
  });

  it('preserves compressed snapshot data while sanitizing the envelope', () => {
    const compressedBytes = '\u001f\u008b/Users/alice/a@example.com\u0000';
    const result = sanitizePostHogEvent(
      {
        event: '$snapshot',
        properties: { $snapshot_data: compressedBytes, note: EMAIL },
      },
      { passthroughProperties: ['$snapshot_data'] },
    );
    expect(result?.properties).toEqual({
      $snapshot_data: compressedBytes,
      note: '<redacted-email>',
    });
  });
  it('preserves the SDK-managed root project token only when explicitly requested', () => {
    const projectToken = 'phc_project-token';
    const event = {
      event: 'app_opened',
      properties: {
        token: projectToken,
        context: { token: 'application-secret', label: 'safe' },
      },
    };

    expect(sanitizePostHogEvent(event)).toEqual({
      event: 'app_opened',
      properties: {
        context: { label: 'safe' },
      },
    });
    expect(
      sanitizePostHogEvent(event, { preserveBrowserProjectToken: true }),
    ).toEqual({
      event: 'app_opened',
      properties: {
        token: projectToken,
        context: { label: 'safe' },
      },
    });
  });

  it('sanitizes top-level person-property maps in the PostHog event envelope', () => {
    expect(
      sanitizePostHogEvent({
        event: '$identify',
        properties: { surface: 'app-advisor' },
        $set: {
          email: EMAIL,
          label: EMAIL,
          $current_url: INSTALL,
        },
        $set_once: {
          prompt: CHAT,
          source_url: INSTALL,
        },
      }),
    ).toEqual({
      event: '$identify',
      properties: { surface: 'app-advisor' },
      $set: {
        label: '<redacted-email>',
        $current_url: 'app://app-advisor',
      },
      $set_once: {
        source_url: 'file:///<redacted>',
      },
    });
  });

  it.each(['main', 'app-advisor'])(
    'replaces SDK locations, including nested initial person properties (%s)',
    (surface) => {
      const locations = Object.fromEntries(
        [
          '$current_url',
          '$pathname',
          '$host',
          '$referrer',
          '$referring_domain',
          '$initial_current_url',
          '$initial_referrer',
          '$initial_pathname',
          '$initial_host',
          '$initial_referring_domain',
          '$session_entry_url',
          '$session_entry_pathname',
          '$session_entry_referrer',
          '$session_entry_referring_domain',
        ].map((key) => [key, `${INSTALL}?token=${TOKEN}#${EMAIL}`]),
      );
      const expected = Object.fromEntries(
        Object.keys(locations).map((key) => [key, `app://${surface}`]),
      );
      expect(
        sanitizePostHogEvent({
          properties: {
            surface,
            ...locations,
            $set: locations,
            $set_once: locations,
          },
        }),
      ).toEqual({
        properties: {
          surface,
          ...expected,
          $set: expected,
          $set_once: expected,
        },
      });
    },
  );

  it.each([undefined, '/Users/alice/private', 'main?secret=value'])(
    'uses a fixed fallback for unrecognized surfaces (%s)',
    (surface) => {
      expect(
        sanitizePostHogEvent({ properties: { surface, $current_url: INSTALL } })
          ?.properties.$current_url,
      ).toBe('app://main');
    },
  );

  it('uses the event route before the current caller route and preserves capture-time attribution', () => {
    const output = sanitizePostHogEvent(
      {
        event: '$pageleave',
        properties: {
          screen_route: 'app://main/home',
          $current_url: INSTALL,
          nested: {
            $initial_current_url: INSTALL,
            $session_entry_url: INSTALL,
          },
        },
      },
      { screenRoute: 'app://settings/display' },
    );
    expect(output).toEqual({
      event: '$pageleave',
      properties: {
        screen_route: 'app://main/home',
        $current_url: 'app://main/home',
        nested: {
          $initial_current_url: 'app://main/home',
          $session_entry_url: 'app://main/home',
        },
      },
    });
    expect(
      sanitizePostHogEvent(output, {
        screenRoute: 'app://settings/account',
      }),
    ).toEqual(output);
  });

  it.each([
    'app://main/private-workspace',
    'app://main/home%2Fprivate',
    'app://main/home?workspace=private',
    'app://main/home#private',
    'app://MAIN/home',
  ])(
    'rejects an adversarial event route and uses the validated option (%s)',
    (route) => {
      expect(
        sanitizePostHogEvent(
          {
            properties: {
              screen_route: route,
              $current_url: INSTALL,
            },
          },
          { screenRoute: 'app://settings/privacy' },
        ),
      ).toEqual({
        properties: {
          screen_route: 'app://settings/privacy',
          $current_url: 'app://settings/privacy',
        },
      });
    },
  );

  it('stamps every renderer event with a validated route while leaving optionless background events unchanged', () => {
    const renderer = sanitizePostHogEvent(
      { event: 'ordinary_renderer_event', properties: { count: 1 } },
      { screenRoute: 'app://panel/terminal' },
    );
    expect(renderer).toEqual({
      event: 'ordinary_renderer_event',
      properties: {
        count: 1,
        screen_route: 'app://panel/terminal',
        $current_url: 'app://panel/terminal',
      },
    });
    expect(sanitizePostHogEvent(renderer)).toEqual(renderer);
    expect(
      sanitizePostHogEvent({
        event: 'desktop:background_event',
        properties: { count: 1 },
      }),
    ).toEqual({
      event: 'desktop:background_event',
      properties: { count: 1 },
    });
  });

  it('drops an invalid route from an optionless event without adding one to unrelated events', () => {
    expect(
      sanitizePostHogEvent({
        properties: { screen_route: 'app://main/<workspace>', count: 1 },
      }),
    ).toEqual({ properties: { count: 1 } });
    expect(sanitizePostHogEvent({ properties: { count: 1 } })).toEqual({
      properties: { count: 1 },
    });
  });

  it('replaces SDK previous-pageview location fields with the synthetic route', () => {
    const pathname =
      '/Applications/App.app/Contents/Resources/app.asar/out/renderer/index.html';
    expect(
      sanitizePostHogEvent({
        properties: {
          screen_route: 'app://main/home',
          $prev_pageview_pathname: pathname,
          $prev_pageview_url: `file://${pathname}`,
        },
      })?.properties,
    ).toEqual({
      screen_route: 'app://main/home',
      $current_url: 'app://main/home',
      $prev_pageview_pathname: 'app://main/home',
      $prev_pageview_url: 'app://main/home',
    });
  });

  it('does not let ordinary text redaction alter a catalog route', () => {
    const route = 'app://main/worktree-chat';
    expect(redactText(route)).toBe(route);
    expect(
      sanitizePostHogEvent(
        { properties: { screen_route: route } },
        { screenRoute: 'app://main/home' },
      )?.properties.screen_route,
    ).toBe(route);
  });

  it.each([
    'file:///C:/Users/alice/AppData/Local/Programs/App/resources/app.asar/out/renderer/index.html',
    'file:///home/alice/app/out/renderer/index.html',
    'file:///Applications/App.app/Contents/Resources/app.asar/out/renderer/index.html',
  ])('removes platform-specific install locations (%s)', (location) => {
    const output = sanitizePostHogEvent({
      properties: { $current_url: location, source_url: location },
    });
    expect(output).toEqual({
      properties: {
        $current_url: 'app://main',
        source_url: 'file:///<redacted>',
      },
    });
    expect(sanitizePostHogEvent(output)).toEqual(output);
  });

  it('scrubs nested custom strings, element text and captured attributes using the shared rules, dropping the element chain string', () => {
    const text = `${TOKEN} ${EMAIL} /Users/alice/project 192.168.1.42`;
    const event = {
      event: '$autocapture',
      properties: {
        $el_text: text,
        $elements: [
          {
            $el_text: text,
            attr__title: text,
            attr__href: `https://example.com/path?token=${TOKEN}#private`,
            tag_name: 'button',
          },
        ],
        $elements_chain: `button:attr__href="https://example.com/path?token=${TOKEN}"`,
        context: { labels: [text, { label: text }] },
      },
    };
    expect(sanitizePostHogEvent(event)).toEqual({
      event: '$autocapture',
      properties: {
        $el_text: redactText(text),
        $elements: [
          {
            $el_text: redactText(text),
            attr__title: redactText(text),
            attr__href: 'https://example.com/path',
            tag_name: 'button',
          },
        ],
        context: { labels: [redactText(text), { label: redactText(text) }] },
      },
    });
  });

  it('drops forbidden content and client location data at every nesting level', () => {
    const forbidden = {
      prompt: CHAT,
      promptText: CHAT,
      chat_excerpt: CHAT,
      transcript: [CHAT],
      file_contents: CHAT,
      terminal_output: CHAT,
      stdout: CHAT,
      stderr: CHAT,
      git_remote: 'git@example.com:private/repo.git',
      workspace_path: '/Users/alice/project',
      email: EMAIL,
      $ip: '192.168.1.42',
      $geoip_city_name: 'Private City',
      $geoip_country_code: 'US',
      $initial_geoip_city_name: 'Private City',
      api_key: 'arbitrary-secret',
      clientSecret: 'another-secret',
      'client.secret': 'separator-secret',
      '$api-key': 'sdk-prefixed-secret',
    };
    expect(
      sanitizePostHogEvent({
        properties: {
          ...forbidden,
          context: forbidden,
          $set_once: forbidden,
          count: 2,
        },
      }),
    ).toEqual({
      properties: { context: {}, $set_once: {}, count: 2 },
    });
    expect(POSTHOG_PROPERTY_DENYLIST).toEqual(
      expect.arrayContaining([
        'prompt',
        'chat_excerpt',
        'transcript',
        'file_contents',
        'terminal_output',
        'usr',
        'usr.id',
        'dd_session_id',
        'dd_view_id',
        '$ip',
      ]),
    );
  });

  it('sanitizes custom URLs including credentials, query strings, fragments, secrets and local files', () => {
    const result = sanitizePostHogEvent({
      properties: {
        source_url: `https://user:password@example.com/${TOKEN}?private=query#fragment`,
        download_url: INSTALL,
        nested: { source_url: 'https://example.com/alice@example.com' },
        $elements: [{ attr__src: INSTALL }],
      },
    });
    const serialized = JSON.stringify(result);
    for (const value of [
      TOKEN,
      EMAIL,
      'user:password',
      'private=query',
      'fragment',
      '/Users/alice',
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(result?.properties.download_url).toBe('file:///<redacted>');
    expect(sanitizePostHogEvent(result)).toEqual(result);
  });

  it('preserves safe metadata, anonymous identity and primitive values without mutating the input', () => {
    const properties = Object.freeze({
      distinct_id: '11111111-2222-4333-8444-555555555555',
      $session_id: '22222222-3333-4444-8555-666666666666',
      surface: 'main',
      status: 'success',
      duration_ms: 42,
      enabled: true,
      empty: null,
      values: Object.freeze([0, false, null, 'safe']),
      context: Object.freeze({ label: EMAIL }),
    });
    const event = Object.freeze({ event: 'operation_completed', properties });
    const output = sanitizePostHogEvent(event);
    expect(output).toEqual({
      ...event,
      properties: { ...properties, context: { label: '<redacted-email>' } },
    });
    expect(event.properties.context.label).toBe(EMAIL);
    expect(output).not.toBe(event);
    expect(sanitizePostHogEvent(output)).toEqual(output);
  });

  it('handles null and events without properties', () => {
    expect(sanitizePostHogEvent(null)).toBeNull();
    expect(
      sanitizePostHogEvent({ event: 'app_opened', properties: undefined }),
    ).toEqual({ event: 'app_opened', properties: undefined });
  });

  it('omits cyclic values without losing safe neighboring properties', () => {
    const context: Record<string, unknown> = { count: 1 };
    context.self = context;
    expect(sanitizePostHogEvent({ properties: { context } })).toEqual({
      properties: { context: { count: 1 } },
    });
  });

  it('does not retain serialization hooks or non-JSON objects that could bypass sanitization', () => {
    const toJSON = jest.fn(() => ({ prompt: CHAT }));
    class PrivateValue {
      toJSON = toJSON;
    }
    const result = sanitizePostHogEvent({
      properties: {
        context: { toJSON, label: EMAIL },
        custom: new PrivateValue(),
      },
    });
    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        properties: { context: { label: '<redacted-email>' } },
      }),
    );
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('does not retain an event-envelope serialization hook', () => {
    const toJSON = jest.fn(() => ({ properties: { prompt: CHAT } }));
    const result = sanitizePostHogEvent({
      event: 'operation_completed',
      properties: { status: 'success' },
      toJSON,
    });

    expect(JSON.stringify(result)).toBe(
      JSON.stringify({
        event: 'operation_completed',
        properties: { status: 'success' },
      }),
    );
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('bounds recursion for deeply nested properties', () => {
    let nested: Record<string, unknown> = { prompt: CHAT };
    for (let i = 0; i < 100; i++) nested = { nested };
    const output = sanitizePostHogEvent({ properties: { nested, count: 1 } });
    expect(output?.properties.count).toBe(1);
    expect(JSON.stringify(output)).not.toContain(CHAT);
    expect(sanitizePostHogEvent(output)).toEqual(output);
  });

  it('keys heatmap samples by the synthetic route and keeps only coordinates', () => {
    const click = { x: 120, y: 48, target_fixed: true, type: 'click' };
    const move = { x: 4, y: 900, target_fixed: false, type: 'mousemove' };
    const output = sanitizePostHogEvent(
      {
        event: '$$heatmap',
        properties: {
          screen_route: 'app://settings/display',
          $heatmap_data: {
            [INSTALL]: [
              click,
              { ...move, text: CHAT, href: INSTALL },
              { x: '1', y: 2, target_fixed: false, type: 'click' },
              { x: 1, y: 2, target_fixed: false, type: EMAIL },
              null,
            ],
            [`http://localhost/?token=${TOKEN}`]: [
              { ...click, type: 'rageclick' },
            ],
            'app://main/home': 'not-a-list',
          },
        },
      },
      { screenRoute: 'app://main/home' },
    );
    expect(output?.properties.$heatmap_data).toEqual({
      'app://settings/display': [click, move, { ...click, type: 'rageclick' }],
    });
    const wire = JSON.stringify(output);
    for (const value of [INSTALL, 'localhost', TOKEN, CHAT, EMAIL]) {
      expect(wire).not.toContain(value);
    }
    expect(sanitizePostHogEvent(output)).toEqual(output);
  });

  it('drops heatmap data that carries no valid sample', () => {
    for (const data of [{ [INSTALL]: [{ text: CHAT }] }, [], INSTALL, null]) {
      const output = sanitizePostHogEvent({
        event: '$$heatmap',
        properties: { $heatmap_data: data, $viewport_width: 1280 },
      });
      expect(output?.properties).not.toHaveProperty('$heatmap_data');
      expect(output?.properties.$viewport_width).toBe(1280);
    }
  });
});
