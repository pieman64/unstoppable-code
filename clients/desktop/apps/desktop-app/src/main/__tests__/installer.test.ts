import * as fs from 'fs';
import * as https from 'node:https';
import { EventEmitter } from 'events';
import { sanitizeName, installSkill } from '../skills/installer';
import { isPathInside as isPathSafe } from '../lib/path-safety';

jest.mock('fs');
jest.mock('node:https');

const mockFs = fs as jest.Mocked<typeof fs>;
const mockHttps = https as jest.Mocked<typeof https>;

function mockHttpsGetSuccess(body: Buffer): void {
  mockHttps.get.mockImplementation((_opts: unknown, cb: unknown) => {
    const res = new EventEmitter() as EventEmitter & {
      statusCode: number;
      headers: Record<string, string>;
    };
    res.statusCode = 200;
    res.headers = {};
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();
    process.nextTick(() => {
      (cb as (res: unknown) => void)(res);
      res.emit('data', body);
      res.emit('end');
    });
    return req as unknown as ReturnType<typeof https.get>;
  });
}

describe('sanitizeName', () => {
  it('lowercases and preserves safe characters', () => {
    expect(sanitizeName('MySkill')).toBe('myskill');
  });

  it('preserves alphanumeric, dots, and underscores', () => {
    expect(sanitizeName('my_skill.v2')).toBe('my_skill.v2');
  });

  it('replaces spaces with hyphens', () => {
    expect(sanitizeName('my cool skill')).toBe('my-cool-skill');
  });

  it('replaces special characters with hyphens', () => {
    expect(sanitizeName('skill@name!here')).toBe('skill-name-here');
  });

  it('collapses multiple consecutive special characters into a single hyphen', () => {
    expect(sanitizeName('skill---name')).toBe('skill-name');
    expect(sanitizeName('a!!!b###c')).toBe('a-b-c');
  });

  it('strips leading dots', () => {
    expect(sanitizeName('.hidden')).toBe('hidden');
    expect(sanitizeName('..double')).toBe('double');
  });

  it('strips leading hyphens', () => {
    expect(sanitizeName('-leading')).toBe('leading');
    expect(sanitizeName('--double')).toBe('double');
  });

  it('strips leading mixed dots and hyphens', () => {
    expect(sanitizeName('.-mixed')).toBe('mixed');
    expect(sanitizeName('-.also')).toBe('also');
  });

  it('strips trailing dots', () => {
    expect(sanitizeName('trailing.')).toBe('trailing');
    expect(sanitizeName('trailing..')).toBe('trailing');
  });

  it('strips trailing hyphens', () => {
    expect(sanitizeName('trailing-')).toBe('trailing');
    expect(sanitizeName('trailing--')).toBe('trailing');
  });

  it('strips trailing mixed dots and hyphens', () => {
    expect(sanitizeName('trailing.-')).toBe('trailing');
    expect(sanitizeName('trailing-.')).toBe('trailing');
  });

  it('strips both leading and trailing dots/hyphens', () => {
    expect(sanitizeName('..name..')).toBe('name');
    expect(sanitizeName('--name--')).toBe('name');
    expect(sanitizeName('.-name-.')).toBe('name');
  });

  it('truncates names longer than 255 characters', () => {
    const longName = 'a'.repeat(300);
    const result = sanitizeName(longName);
    expect(result).toHaveLength(255);
    expect(result).toBe('a'.repeat(255));
  });

  it('returns unnamed-skill when name becomes empty after sanitization', () => {
    expect(sanitizeName('...')).toBe('unnamed-skill');
    expect(sanitizeName('---')).toBe('unnamed-skill');
    expect(sanitizeName('!!!')).toBe('unnamed-skill');
  });

  it('returns unnamed-skill for an empty input string', () => {
    expect(sanitizeName('')).toBe('unnamed-skill');
  });

  it('handles a realistic mixed-case name with spaces and symbols', () => {
    expect(sanitizeName('Claude Code — Best Practices v2.0')).toBe(
      'claude-code-best-practices-v2.0',
    );
  });
});

describe('isPathSafe', () => {
  it('returns true when target is a subdirectory of base', () => {
    expect(isPathSafe('/home/user/skills', '/home/user/skills/my-skill')).toBe(
      true,
    );
  });

  it('returns true when target is a deeply nested subdirectory', () => {
    expect(isPathSafe('/home/user/skills', '/home/user/skills/a/b/c')).toBe(
      true,
    );
  });

  it('returns true when target equals base', () => {
    expect(isPathSafe('/home/user/skills', '/home/user/skills')).toBe(true);
  });

  it('returns false when target is outside base via .. traversal', () => {
    expect(
      isPathSafe('/home/user/skills', '/home/user/skills/../secrets'),
    ).toBe(false);
  });

  it('returns false when target is a sibling directory', () => {
    expect(isPathSafe('/home/user/skills', '/home/user/other')).toBe(false);
  });

  it('returns false when target is a parent directory', () => {
    expect(isPathSafe('/home/user/skills', '/home/user')).toBe(false);
  });

  it('returns false when target is the root directory', () => {
    expect(isPathSafe('/home/user/skills', '/')).toBe(false);
  });

  it('returns false for a base name prefix that is not a directory boundary', () => {
    expect(isPathSafe('/home/user/skills', '/home/user/skills-extra/foo')).toBe(
      false,
    );
  });

  it('handles paths with trailing separators via normalize', () => {
    expect(isPathSafe('/home/user/skills/', '/home/user/skills/my-skill')).toBe(
      true,
    );
  });

  it('returns false for double-dot traversal escaping base', () => {
    expect(
      isPathSafe('/home/user/skills', '/home/user/skills/../../etc/passwd'),
    ).toBe(false);
  });
});

describe('installSkill', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false);
    mockFs.mkdirSync.mockReturnValue(undefined);
    mockFs.rmSync.mockReturnValue(undefined);
    mockFs.writeFileSync.mockReturnValue(undefined);
  });

  it('downloads files and writes them to the skill directory', async () => {
    const fileContent = Buffer.from('# My Skill');
    mockHttpsGetSuccess(fileContent);

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'My Skill', description: '', sourcePath: 'skills/my-skill' },
      [
        { path: 'skills/my-skill/SKILL.md', type: 'blob' },
        { path: 'skills/my-skill/lib/helper.ts', type: 'blob' },
      ],
      '/source/dir',
      null,
    );

    expect(mockFs.mkdirSync).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('cleans existing directory before installing', async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [{ path: 'skills/test/SKILL.md', type: 'blob' }],
      '/source/dir',
      null,
    );

    expect(mockFs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('test'),
      { recursive: true, force: true },
    );
  });

  it('skips non-blob tree entries', async () => {
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [
        { path: 'skills/test', type: 'tree' },
        { path: 'skills/test/SKILL.md', type: 'blob' },
      ],
      '/source/dir',
      null,
    );

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('skips files outside the source path prefix', async () => {
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [
        { path: 'skills/other/README.md', type: 'blob' },
        { path: 'skills/test/SKILL.md', type: 'blob' },
      ],
      '/source/dir',
      null,
    );

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('skips excluded files (metadata.json)', async () => {
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [
        { path: 'skills/test/metadata.json', type: 'blob' },
        { path: 'skills/test/SKILL.md', type: 'blob' },
      ],
      '/source/dir',
      null,
    );

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('skips files starting with underscore', async () => {
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [
        { path: 'skills/test/_internal.ts', type: 'blob' },
        { path: 'skills/test/SKILL.md', type: 'blob' },
      ],
      '/source/dir',
      null,
    );

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('skips files inside .git directories', async () => {
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [
        { path: 'skills/test/.git/config', type: 'blob' },
        { path: 'skills/test/SKILL.md', type: 'blob' },
      ],
      '/source/dir',
      null,
    );

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('sets authorization header when token is provided', async () => {
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [{ path: 'skills/test/SKILL.md', type: 'blob' }],
      '/source/dir',
      'ghp_token123',
    );

    const callArgs = mockHttps.get.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    const headers = callArgs.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer ghp_token123');
  });

  it('handles root sourcePath', async () => {
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: '.' },
      [
        { path: 'SKILL.md', type: 'blob' },
        { path: 'sub/file.ts', type: 'blob' },
      ],
      '/source/dir',
      null,
    );

    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('creates parent directories for nested files', async () => {
    mockHttpsGetSuccess(Buffer.from('content'));

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [{ path: 'skills/test/sub/deep/file.ts', type: 'blob' }],
      '/source/dir',
      null,
    );

    expect(mockFs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('sub'),
      expect.objectContaining({ recursive: true }),
    );
  });

  it('handles redirect responses', async () => {
    let callCount = 0;
    mockHttps.get.mockImplementation((_opts: unknown, cb: unknown) => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: jest.Mock;
        destroy: jest.Mock;
      };
      req.setTimeout = jest.fn();
      req.destroy = jest.fn();

      process.nextTick(() => {
        callCount++;
        if (callCount === 1) {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
          };
          res.statusCode = 302;
          res.headers = { location: 'https://redirected.example.com/file' };
          (cb as (res: unknown) => void)(res);
        } else {
          const res = new EventEmitter() as EventEmitter & {
            statusCode: number;
            headers: Record<string, string>;
          };
          res.statusCode = 200;
          res.headers = {};
          (cb as (res: unknown) => void)(res);
          res.emit('data', Buffer.from('content'));
          res.emit('end');
        }
      });

      return req as unknown as ReturnType<typeof https.get>;
    });

    await installSkill(
      'owner',
      'repo',
      'main',
      { name: 'test', description: '', sourcePath: 'skills/test' },
      [{ path: 'skills/test/SKILL.md', type: 'blob' }],
      '/source/dir',
      null,
    );

    expect(mockHttps.get).toHaveBeenCalledTimes(2);
  });

  it('rejects on HTTP error status', async () => {
    mockHttps.get.mockImplementation((_opts: unknown, cb: unknown) => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.statusCode = 404;
      res.headers = {};
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: jest.Mock;
        destroy: jest.Mock;
      };
      req.setTimeout = jest.fn();
      req.destroy = jest.fn();
      process.nextTick(() => {
        (cb as (res: unknown) => void)(res);
      });
      return req as unknown as ReturnType<typeof https.get>;
    });

    await expect(
      installSkill(
        'owner',
        'repo',
        'main',
        { name: 'test', description: '', sourcePath: 'skills/test' },
        [{ path: 'skills/test/SKILL.md', type: 'blob' }],
        '/source/dir',
        null,
      ),
    ).rejects.toThrow('HTTP 404');
  });

  it('rejects on request error', async () => {
    mockHttps.get.mockImplementation(() => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: jest.Mock;
        destroy: jest.Mock;
      };
      req.setTimeout = jest.fn();
      req.destroy = jest.fn();
      process.nextTick(() => {
        req.emit('error', new Error('ECONNREFUSED'));
      });
      return req as unknown as ReturnType<typeof https.get>;
    });

    await expect(
      installSkill(
        'owner',
        'repo',
        'main',
        { name: 'test', description: '', sourcePath: 'skills/test' },
        [{ path: 'skills/test/SKILL.md', type: 'blob' }],
        '/source/dir',
        null,
      ),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('rejects on timeout', async () => {
    mockHttps.get.mockImplementation(() => {
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

    await expect(
      installSkill(
        'owner',
        'repo',
        'main',
        { name: 'test', description: '', sourcePath: 'skills/test' },
        [{ path: 'skills/test/SKILL.md', type: 'blob' }],
        '/source/dir',
        null,
      ),
    ).rejects.toThrow('Request timed out');
  });

  it('rejects on response stream error', async () => {
    mockHttps.get.mockImplementation((_opts: unknown, cb: unknown) => {
      const res = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
      };
      res.statusCode = 200;
      res.headers = {};
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: jest.Mock;
        destroy: jest.Mock;
      };
      req.setTimeout = jest.fn();
      req.destroy = jest.fn();
      process.nextTick(() => {
        (cb as (res: unknown) => void)(res);
        res.emit('error', new Error('stream error'));
      });
      return req as unknown as ReturnType<typeof https.get>;
    });

    await expect(
      installSkill(
        'owner',
        'repo',
        'main',
        { name: 'test', description: '', sourcePath: 'skills/test' },
        [{ path: 'skills/test/SKILL.md', type: 'blob' }],
        '/source/dir',
        null,
      ),
    ).rejects.toThrow('stream error');
  });
});
