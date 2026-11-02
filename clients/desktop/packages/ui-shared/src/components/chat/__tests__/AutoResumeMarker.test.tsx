/**
 * Server-rendered tests for the shared {@link AutoResumeMarker} (CAN-4897):
 * copy per recorded reason, persisted time, and provenance reads that never
 * consult prompt text.
 */
import { renderToString } from 'react-dom/server';
import { ChatAppNameProvider } from '../../chat-look';
import {
  AutoResumeMarker,
  autoResumeAttribution,
  autoResumeHeadline,
  formatAutoResumeTime,
  readMessageAutoResume,
} from '../AutoResumeMarker';

const AT = new Date(2026, 9, 25, 21, 41).getTime();
const TIME = formatAutoResumeTime(AT);

describe('autoResumeHeadline', () => {
  it('names the app only for a known shutdown', () => {
    expect(
      autoResumeHeadline(
        { reason: 'app_shutdown', resendsUserMessage: false },
        TIME,
        'Canopy',
      ),
    ).toBe(`Canopy closed · resumed ${TIME}`);
  });

  it('never claims a usage limit reset', () => {
    const text = autoResumeHeadline(
      { reason: 'usage_limit', resendsUserMessage: false },
      TIME,
      'Canopy',
      'Claude',
    );
    expect(text).toBe(`Resumed after Claude usage limit · ${TIME}`);
    expect(text).not.toContain('reset');
  });

  it('uses neutral wording for recovery and unknown provenance', () => {
    expect(
      autoResumeHeadline(
        { reason: 'auth_recovery', resendsUserMessage: false },
        TIME,
        'Canopy',
      ),
    ).toBe(`Resumed after sign-in recovery · ${TIME}`);
    expect(autoResumeHeadline(undefined, TIME, 'Canopy')).toBe(
      `Sent automatically · ${TIME}`,
    );
  });
});

describe('autoResumeAttribution', () => {
  it('quotes a generated nudge and describes a re-send', () => {
    expect(
      autoResumeAttribution(
        { reason: 'app_shutdown', resendsUserMessage: false },
        'Continue',
      ),
    ).toBe('Sent automatically: Continue');
    expect(
      autoResumeAttribution(
        { reason: 'usage_limit', resendsUserMessage: true },
        'Fix the build',
      ),
    ).toBe('Sent automatically · re-sent your last message');
    expect(autoResumeAttribution(undefined, 'Continue')).toBeNull();
  });
});

describe('formatAutoResumeTime', () => {
  it('formats the persisted time independent of the current clock', () => {
    expect(formatAutoResumeTime(AT)).toBe(TIME);
    expect(TIME).not.toMatch(/ago|just now/);
    expect(formatAutoResumeTime(Number.NaN)).toBe('');
  });
});

describe('readMessageAutoResume', () => {
  it('reads direct metadata, then a cached prompt_source part', () => {
    const autoResume = { reason: 'app_shutdown', resendsUserMessage: false };
    expect(readMessageAutoResume({ autoResume })).toEqual(autoResume);
    expect(
      readMessageAutoResume({
        parts: [
          { kind: 'text', data: {} },
          { kind: 'prompt_source', data: { source: 'automated', autoResume } },
        ],
      }),
    ).toEqual(autoResume);
  });

  it('rejects unknown reasons and never reads prompt text', () => {
    expect(
      readMessageAutoResume({
        autoResume: { reason: 'future', resendsUserMessage: false },
      }),
    ).toBeUndefined();
    expect(
      readMessageAutoResume({
        parts: [{ kind: 'prompt_source', data: { source: 'automated' } }],
      }),
    ).toBeUndefined();
    expect(readMessageAutoResume({ parts: 'Continue' })).toBeUndefined();
  });
});

describe('AutoResumeMarker', () => {
  it('renders one shutdown marker with the host app name', () => {
    const html = renderToString(
      <ChatAppNameProvider value="Canopy">
        <AutoResumeMarker
          autoResume={{
            reason: 'app_shutdown',
            resumesUserMessageId: 'original',
            resendsUserMessage: false,
          }}
          timestamp={AT}
          text="Continue"
        />
      </ChatAppNameProvider>,
    );
    expect(html).toContain('data-auto-resume-reason="app_shutdown"');
    expect(html).toContain('data-auto-resume-resends="false"');
    expect(html).toContain(`Canopy closed · resumed ${TIME}`);
    expect(html).toContain('Sent automatically: Continue');
    expect(html.match(/data-testid="auto-resume-marker"/g)).toHaveLength(1);
  });

  it('renders generic attribution without a reason line', () => {
    const html = renderToString(
      <AutoResumeMarker timestamp={AT} text="Continue" />,
    );
    expect(html).toContain('data-auto-resume-reason="unknown"');
    expect(html).not.toContain('auto-resume-marker-attribution');
    expect(html).not.toContain('closed');
  });
});
