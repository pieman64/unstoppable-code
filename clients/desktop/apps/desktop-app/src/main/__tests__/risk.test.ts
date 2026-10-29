import * as https from 'node:https';
import { EventEmitter } from 'node:events';
import { fetchRiskAssessment } from '../skills/risk';

jest.mock('node:https');

const mockedHttps = https as jest.Mocked<typeof https>;

function mockHttpsGet(responseBody: string, statusCode = 200): void {
  mockedHttps.get.mockImplementation((_opts, callback) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = statusCode;

    const req = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();

    process.nextTick(() => {
      (callback as (res: EventEmitter & { statusCode: number }) => void)(res);
      res.emit('data', Buffer.from(responseBody));
      res.emit('end');
    });

    return req as unknown as ReturnType<typeof https.get>;
  });
}

function mockHttpsGetError(error: Error): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  mockedHttps.get.mockImplementation((_opts, _callback) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();

    process.nextTick(() => {
      req.emit('error', error);
    });

    return req as unknown as ReturnType<typeof https.get>;
  });
}

function mockHttpsGetHttpError(statusCode: number): void {
  mockedHttps.get.mockImplementation((_opts, callback) => {
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = statusCode;

    const req = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();

    process.nextTick(() => {
      (callback as (res: EventEmitter & { statusCode: number }) => void)(res);
    });

    return req as unknown as ReturnType<typeof https.get>;
  });
}

function mockHttpsGetTimeout(): void {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  mockedHttps.get.mockImplementation((_opts, _callback) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    req.destroy = jest.fn();
    req.setTimeout = jest.fn((_ms: number, cb: () => void) => {
      process.nextTick(cb);
    });

    return req as unknown as ReturnType<typeof https.get>;
  });
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe('fetchRiskAssessment', () => {
  it('returns empty object when skillNames is empty', async () => {
    const result = await fetchRiskAssessment('github:acme/tools', []);
    expect(result).toEqual({});
    expect(mockedHttps.get).not.toHaveBeenCalled();
  });

  it('returns unknown when skill has no audits in response', async () => {
    mockHttpsGet(JSON.stringify({}));
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'unknown', socketAlerts: null },
    });
  });

  it('returns safe with 0 socketAlerts when socket analyzer has 0 alerts', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          socket: { alerts: 0, score: 95, analyzedAt: '2025-01-01' },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'safe', socketAlerts: 0 },
    });
  });

  it('returns high with socketAlerts when socket analyzer has >0 alerts', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          socket: { alerts: 5, score: 30, analyzedAt: '2025-01-01' },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'high', socketAlerts: 5 },
    });
  });

  it('uses risk level from non-socket analyzer', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          snyk: { risk: 'medium' },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'medium', socketAlerts: null },
    });
  });

  it('returns unknown for non-socket analyzer with undefined risk', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          snyk: { score: 50 },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'unknown', socketAlerts: null },
    });
  });

  it('returns unknown for non-socket analyzer with invalid risk string', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          snyk: { risk: 'banana' },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'unknown', socketAlerts: null },
    });
  });

  describe('toRiskLevel handles case-insensitive valid levels', () => {
    it.each([
      ['Safe', 'safe'],
      ['LOW', 'low'],
      ['Medium', 'medium'],
      ['HIGH', 'high'],
      ['CRITICAL', 'critical'],
      ['unknown', 'unknown'],
    ])('normalizes "%s" to "%s"', async (input, expected) => {
      mockHttpsGet(
        JSON.stringify({
          'my-skill': {
            analyzer: { risk: input },
          },
        }),
      );
      const result = await fetchRiskAssessment('github:acme/tools', [
        'my-skill',
      ]);
      expect(result['my-skill'].level).toBe(expected);
    });
  });

  it('picks highest risk when multiple analyzers are present', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          snyk: { risk: 'low' },
          audit: { risk: 'critical' },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'critical', socketAlerts: null },
    });
  });

  it('picks highest risk across socket and non-socket analyzers', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          socket: { alerts: 0 },
          audit: { risk: 'medium' },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'medium', socketAlerts: 0 },
    });
  });

  it('socket high overrides non-socket low', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          audit: { risk: 'low' },
          socket: { alerts: 3 },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'high', socketAlerts: 3 },
    });
  });

  it('handles multiple skills in a single request', async () => {
    mockHttpsGet(
      JSON.stringify({
        'skill-a': {
          socket: { alerts: 0 },
        },
        'skill-b': {
          snyk: { risk: 'high' },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', [
      'skill-a',
      'skill-b',
      'skill-c',
    ]);
    expect(result).toEqual({
      'skill-a': { level: 'safe', socketAlerts: 0 },
      'skill-b': { level: 'high', socketAlerts: null },
      'skill-c': { level: 'unknown', socketAlerts: null },
    });
  });

  it('returns empty object when network request fails', async () => {
    mockHttpsGetError(new Error('ECONNREFUSED'));
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({});
  });

  it('returns empty object when HTTP status >= 400', async () => {
    mockHttpsGetHttpError(500);
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({});
  });

  it('returns empty object when request times out', async () => {
    mockHttpsGetTimeout();
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({});
  });

  it('returns empty object when response is invalid JSON', async () => {
    mockHttpsGet('not valid json{{{');
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({});
  });

  it('returns empty object when response stream errors', async () => {
    mockedHttps.get.mockImplementation((_opts, callback) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;

      const req = new EventEmitter() as EventEmitter & {
        setTimeout: jest.Mock;
        destroy: jest.Mock;
      };
      req.setTimeout = jest.fn();
      req.destroy = jest.fn();

      process.nextTick(() => {
        (callback as (res: EventEmitter & { statusCode: number }) => void)(res);
        res.emit('error', new Error('stream error'));
      });

      return req as unknown as ReturnType<typeof https.get>;
    });

    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({});
  });

  it('socket analyzer without alerts field falls through to toRiskLevel', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          socket: { risk: 'low', score: 80 },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'low', socketAlerts: null },
    });
  });

  it('highestRisk returns first when both are equal', async () => {
    mockHttpsGet(
      JSON.stringify({
        'my-skill': {
          'analyzer-a': { risk: 'medium' },
          'analyzer-b': { risk: 'medium' },
        },
      }),
    );
    const result = await fetchRiskAssessment('github:acme/tools', ['my-skill']);
    expect(result).toEqual({
      'my-skill': { level: 'medium', socketAlerts: null },
    });
  });

  it('constructs correct URL with source and skill names', async () => {
    mockHttpsGet(JSON.stringify({}));
    await fetchRiskAssessment('github:acme/tools', ['skill-a', 'skill-b']);

    expect(mockedHttps.get).toHaveBeenCalledTimes(1);
    const callArgs = mockedHttps.get.mock.calls[0][0] as unknown as {
      hostname: string;
      path: string;
      headers: Record<string, string>;
    };
    expect(callArgs.hostname).toBe('add-skill.vercel.sh');
    expect(callArgs.path).toContain('/audit');
    expect(callArgs.path).toContain('source=github%3Aacme%2Ftools');
    expect(callArgs.path).toContain('skills=skill-a%2Cskill-b');
    expect(callArgs.headers['User-Agent']).toBe('canopy-skills');
    expect(callArgs.headers['Accept']).toBe('application/json');
  });
});
