import {
  DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX,
  normalizeRendererAssetReferences,
  redactRumEvent,
  redactText,
  redactUrl,
  sanitizeDatadogInstrumentationContext,
} from '../privacy';

describe('desktop instrumentation privacy', () => {
  it('normalizes packaged renderer asset file URLs for Datadog sourcemaps', () => {
    expect(
      normalizeRendererAssetReferences(
        'file:///Applications/Canopy.app/Contents/Resources/app.asar/out/renderer/assets/index-AbCdEf12.js:1:234',
      ),
    ).toBe(
      `${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/index-AbCdEf12.js:1:234`,
    );
  });

  it('normalizes Windows packaged renderer asset file URLs', () => {
    expect(
      normalizeRendererAssetReferences(
        'file:///C:/Users/alice/AppData/Local/Programs/Canopy/resources/app.asar/out/renderer/assets/vendor-react-123.js:2:3',
      ),
    ).toBe(
      `${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/vendor-react-123.js:2:3`,
    );
  });

  it('normalizes renderer scheme asset URLs for Datadog sourcemaps', () => {
    expect(
      normalizeRendererAssetReferences(
        'at x (app-renderer://bundle/assets/index-AbCdEf12.js:1:234)',
      ),
    ).toBe(
      `at x (${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/index-AbCdEf12.js:1:234)`,
    );
    expect(
      redactUrl('app-renderer://bundle/assets/chunk-123.css?token=abc#x'),
    ).toBe(
      `${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/chunk-123.css`,
    );
  });

  it('keeps renderer scheme page paths but drops their query and fragment', () => {
    expect(
      redactUrl(
        'app-renderer://bundle/app-advisor.html?surface=app-advisor&token=abc#chat/1',
      ),
    ).toBe('app-renderer://bundle/app-advisor.html');
    expect(redactUrl('app-renderer://bundle/index.html#/Users/alice/x')).toBe(
      'app-renderer://bundle/index.html',
    );
  });

  it('does not treat look-alike scheme hosts as renderer assets', () => {
    expect(
      normalizeRendererAssetReferences(
        'app-renderer://evil/assets/index-AbCdEf12.js',
      ),
    ).toBe('app-renderer://evil/assets/index-AbCdEf12.js');
  });

  it('normalizes renderer scheme frames in RUM error stacks', () => {
    const event = {
      error: {
        stack:
          'at render (app-renderer://bundle/assets/index-AbCdEf12.js:1:234)',
        resource: { url: 'app-renderer://bundle/assets/index-AbCdEf12.js' },
      },
      view: {
        url: 'app-renderer://bundle/index.html?secret=1',
        referrer: 'app-renderer://bundle/index.html#/Users/alice',
      },
    };
    expect(redactRumEvent(event)).toBe(true);
    expect(event.error.stack).toBe(
      `at render (${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/index-AbCdEf12.js:1:234)`,
    );
    expect(event.error.resource.url).toBe(
      `${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/index-AbCdEf12.js`,
    );
    expect(event.view.url).toBe('app-renderer://bundle/index.html');
    expect(event.view.referrer).toBe('app-renderer://bundle/index.html');
  });

  it('still redacts non-renderer local file URLs', () => {
    expect(redactUrl('file:///Users/alice/private/project.txt?token=abc')).toBe(
      'file:///<redacted>',
    );
  });

  it('preserves normalized renderer stack frames while redacting secrets', () => {
    expect(
      redactText(
        'Error at file:///Users/alice/Canopy.app/Contents/Resources/app.asar/out/renderer/assets/index-AbCdEf12.js:1:234 token=secret',
      ),
    ).toBe(
      `Error at ${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/index-AbCdEf12.js:1:234 token=<redacted>`,
    );
  });

  it('preserves a bare anonymous install UUID untouched', () => {
    const anonId = '11111111-2222-4333-8444-555555555555';
    expect(redactText(anonId)).toBe(anonId);
    expect(redactText(`anon_id=${anonId}`)).toContain(anonId);
  });

  it('removes PostHog identity spellings only from Datadog contexts', () => {
    expect(
      sanitizeDatadogInstrumentationContext({
        channel: 'chat',
        distinct_id: 'person-id',
        posthogDistinctId: 'person-id-alias',
        $session_id: 'session-id',
        posthog_session_id: 'session-id-alias',
      }),
    ).toEqual({ channel: 'chat' });
  });

  it('redacts JSON-style and header-style secrets in text', () => {
    expect(
      redactText(
        'payload={"api_key":"abc123","token":"secret"} Authorization: Bearer abc.def Cookie: session=secret',
      ),
    ).toBe(
      'payload={"api_key":"<redacted>","token":"<redacted>"} Authorization: <redacted>',
    );
  });

  it('normalizes mutable RUM error and resource URL fields', () => {
    const event = {
      type: 'error',
      error: {
        stack:
          'at render (file:///Applications/Canopy.app/Contents/Resources/app.asar/out/renderer/assets/index-AbCdEf12.js:1:234)',
        resource: {
          url: 'file:///Applications/Canopy.app/Contents/Resources/app.asar/out/renderer/assets/index-AbCdEf12.js?token=abc',
        },
      },
      long_task: {
        scripts: [
          {
            source_url:
              'file:///Applications/Canopy.app/Contents/Resources/app.asar/out/renderer/assets/vendor-react-123.js',
          },
        ],
      },
      resource: {
        url: 'file:///Users/alice/private/file.txt',
      },
    };

    expect(redactRumEvent(event)).toBe(true);
    expect(event.error.stack).toContain(
      `${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/index-AbCdEf12.js:1:234`,
    );
    expect(event.error.resource.url).toBe(
      `${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/index-AbCdEf12.js`,
    );
    expect(event.long_task.scripts[0].source_url).toBe(
      `${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/vendor-react-123.js`,
    );
    expect(event.resource.url).toBe('file:///<redacted>');
  });

  it('still redacts object-shaped long-task script records defensively', () => {
    const event = {
      long_task: {
        scripts: {
          source_url:
            'file:///Applications/Canopy.app/Contents/Resources/app.asar/out/renderer/assets/chunk-123.css',
        },
      },
    };

    expect(redactRumEvent(event)).toBe(true);
    expect(event.long_task.scripts.source_url).toBe(
      `${DEFAULT_DATADOG_RENDERER_SOURCEMAP_MINIFIED_PATH_PREFIX}/chunk-123.css`,
    );
  });

  it('redacts nested automatic action target names defensively', () => {
    const event = {
      action: {
        target: {
          name: 'Open /Users/alice/private/project token=secret',
        },
      },
    };

    expect(redactRumEvent(event)).toBe(true);
    expect(event.action.target.name).toBe(
      'Open <user-home>/private/project token=<redacted>',
    );
  });
});
