import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
  vi.resetModules();
  restoreEnv();
  process.env.BRIGHTSPACE_BASE_URL = 'https://brightspace.example.com';
  process.env.BRIGHTSPACE_AUTH_HOST = 'https://auth.brightspace.com';
  process.env.MCP_BEARER = 'test-bearer';
  process.env.BRIGHTSPACE_ACCESS_TOKEN = 'test-token';
  process.env.BRIGHTSPACE_LP_VERSION = '1.49';
  process.env.BRIGHTSPACE_LE_VERSION = '1.82';
  delete process.env.BRIGHTSPACE_TIMEZONE;
  delete process.env.BRIGHTSPACE_HTTP_TIMEOUT_MS;
});

afterEach(() => {
  vi.resetModules();
  restoreEnv();
});

describe('loadEnv', () => {
  it('defaults BRIGHTSPACE_TIMEZONE to UTC when unset', async () => {
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const env = envModule.loadEnv();
    expect(env.brightspaceTimezone).toBe('UTC');
  });

  it('defaults BRIGHTSPACE_HTTP_TIMEOUT_MS to 15000 when unset', async () => {
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const env = envModule.loadEnv();
    expect(env.brightspaceHttpTimeoutMs).toBe(15000);
  });

  it('throws for invalid BRIGHTSPACE_TIMEZONE', async () => {
    process.env.BRIGHTSPACE_TIMEZONE = 'Invalid/Zone';
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    expect(() => envModule.loadEnv()).toThrowError(
      /BRIGHTSPACE_TIMEZONE must be a valid IANA time zone name\./
    );
  });

  it('throws for invalid BRIGHTSPACE_HTTP_TIMEOUT_MS', async () => {
    process.env.BRIGHTSPACE_HTTP_TIMEOUT_MS = '500';
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    expect(() => envModule.loadEnv()).toThrowError(/BRIGHTSPACE_HTTP_TIMEOUT_MS/);
  });
});

describe('toBrightspaceTimezone', () => {
  it('converts ISO timestamps into the configured time zone', async () => {
    process.env.BRIGHTSPACE_TIMEZONE = 'America/Toronto';
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const timezoneModule = await import('../core/timezone.js');
    const result = timezoneModule.toBrightspaceTimezone('2024-07-01T15:00:00Z');
    expect(result).toBe('2024-07-01T11:00:00-04:00');
  });

  it('preserves nullish or invalid inputs', async () => {
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const timezoneModule = await import('../core/timezone.js');
    expect(timezoneModule.toBrightspaceTimezone(null)).toBeNull();
    expect(timezoneModule.toBrightspaceTimezone(undefined)).toBeUndefined();
    expect(timezoneModule.toBrightspaceTimezone('not-a-date')).toBe('not-a-date');
  });
});

describe('mappers', () => {
  it('maps Brightspace course materials', async () => {
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const mappers = await import('../tools/mappers.js');

    const modules = mappers.mapCourseMaterials([
      {
        ModuleId: 1,
        Title: 'Week 1',
        StartDateTime: '2024-07-01T12:00:00Z',
        Topics: [
          {
            TopicId: 2,
            Title: 'Intro',
            Url: 'https://brightspace.example.com/content/2',
            IsHidden: false
          }
        ]
      }
    ]);

    expect(modules[0]?.topics[0]?.title).toBe('Intro');
    expect(modules[0]?.topics[0]?.url).toBe('https://brightspace.example.com/content/2');
  });

  it('maps file and folder paths', async () => {
    const envModule = await import('../core/env.js');
    envModule.resetEnvCacheForTesting();
    const mappers = await import('../tools/mappers.js');

    const file = mappers.mapFile({
      Name: 'Syllabus',
      path: '/Syllabus.pdf'
    });

    const folder = mappers.mapFolder({
      Name: 'Week 1',
      path: '/Week 1'
    });

    expect(file.path).toBe('/Syllabus.pdf');
    expect(folder.path).toBe('/Week 1');
  });
});
