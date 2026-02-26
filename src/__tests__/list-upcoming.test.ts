import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../core/errors.js';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

async function loadListUpcomingHandler(brightspace: {
  getPagedResultSet: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  lp: ReturnType<typeof vi.fn>;
  le: ReturnType<typeof vi.fn>;
}) {
  const tools = new Map<string, unknown>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: unknown) => {
      tools.set(name, handler);
    }
  };

  const { registerBrightspaceTools } = await import('../tools/index.js');
  registerBrightspaceTools(server as never, { brightspace: brightspace as never });

  const handler = tools.get('list_upcoming');
  if (!handler || typeof handler !== 'function') {
    throw new Error('list_upcoming not registered');
  }

  return handler as (args: {
    days?: number;
    max_courses?: number;
  }) => Promise<{ structuredContent: { upcoming: Array<{ id: number }> } }>;
}

beforeEach(() => {
  vi.resetModules();
  restoreEnv();
  process.env.BRIGHTSPACE_BASE_URL = 'https://brightspace.example.com';
  process.env.BRIGHTSPACE_AUTH_HOST = 'https://auth.brightspace.com';
  process.env.MCP_BEARER = 'test-bearer';
  process.env.BRIGHTSPACE_ACCESS_TOKEN = 'test-token';
  process.env.BRIGHTSPACE_TIMEZONE = 'UTC';
  process.env.BRIGHTSPACE_LP_VERSION = '1.49';
  process.env.BRIGHTSPACE_LE_VERSION = '1.82';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  restoreEnv();
});

describe('list_upcoming', () => {
  it('orders upcoming items by due date and respects max_courses', async () => {
    const brightspace = {
      lp: vi.fn((path: string) => `/d2l/api/lp/1.49${path}`),
      le: vi.fn((path: string) => `/d2l/api/le/1.82${path}`),
      getPagedResultSet: vi.fn(async (_path: string) => ({
        data: [
          { OrgUnit: { Id: 1, Name: 'Course 1', Code: 'C1' }, Access: { CanAccess: true } },
          { OrgUnit: { Id: 2, Name: 'Course 2', Code: 'C2' }, Access: { CanAccess: true } }
        ],
        status: 200,
        requestId: 'courses'
      })),
      get: vi.fn(async (path: string) => {
        if (path === '/d2l/api/le/1.82/1/dropbox/folders/') {
          return {
            data: [
              {
                Id: 20,
                Name: 'Assignment A',
                DueDate: '2025-01-02T00:00:00Z'
              }
            ],
            status: 200,
            requestId: 'a1'
          };
        }

        if (path === '/d2l/api/le/1.82/2/dropbox/folders/') {
          return {
            data: [
              {
                Id: 30,
                Name: 'Assignment B',
                DueDate: '2025-01-05T00:00:00Z'
              }
            ],
            status: 200,
            requestId: 'a2'
          };
        }

        throw new Error(`Unexpected path ${path}`);
      })
    };

    const handler = await loadListUpcomingHandler(brightspace);
    const result = await handler({ days: 7, max_courses: 1 });

    expect(result.structuredContent.upcoming.map((item) => item.id)).toEqual([20]);
    expect(brightspace.get.mock.calls.some(([path]) => path === '/d2l/api/le/1.82/2/dropbox/folders/'))
      .toBe(false);
  });

  it('skips courses that fail assignment fetches', async () => {
    const brightspace = {
      lp: vi.fn((path: string) => `/d2l/api/lp/1.49${path}`),
      le: vi.fn((path: string) => `/d2l/api/le/1.82${path}`),
      getPagedResultSet: vi.fn(async (_path: string) => ({
        data: [
          { OrgUnit: { Id: 1, Name: 'Course 1', Code: 'C1' }, Access: { CanAccess: true } },
          { OrgUnit: { Id: 2, Name: 'Course 2', Code: 'C2' }, Access: { CanAccess: true } }
        ],
        status: 200,
        requestId: 'courses'
      })),
      get: vi.fn(async (path: string) => {
        if (path === '/d2l/api/le/1.82/1/dropbox/folders/') {
          return {
            data: [
              {
                Id: 20,
                Name: 'Assignment A',
                DueDate: '2025-01-02T00:00:00Z'
              }
            ],
            status: 200,
            requestId: 'a1'
          };
        }

        if (path === '/d2l/api/le/1.82/2/dropbox/folders/') {
          throw new AppError('BRIGHTSPACE_UNAVAILABLE', 'Brightspace down', 503, {
            brightspaceStatus: 503
          });
        }

        throw new Error(`Unexpected path ${path}`);
      })
    };

    const handler = await loadListUpcomingHandler(brightspace);
    const result = await handler({ days: 7 });

    expect(result.structuredContent.upcoming.map((item) => item.id)).toEqual([20]);
    expect(brightspace.get.mock.calls.some(([path]) => path === '/d2l/api/le/1.82/2/dropbox/folders/'))
      .toBe(true);
  });

  it('throws when all assignment fetches fail with non-auth errors', async () => {
    const brightspace = {
      lp: vi.fn((path: string) => `/d2l/api/lp/1.49${path}`),
      le: vi.fn((path: string) => `/d2l/api/le/1.82${path}`),
      getPagedResultSet: vi.fn(async (_path: string) => ({
        data: [
          { OrgUnit: { Id: 1, Name: 'Course 1', Code: 'C1' }, Access: { CanAccess: true } },
          { OrgUnit: { Id: 2, Name: 'Course 2', Code: 'C2' }, Access: { CanAccess: true } }
        ],
        status: 200,
        requestId: 'courses'
      })),
      get: vi.fn(async (path: string) => {
        if (path === '/d2l/api/le/1.82/1/dropbox/folders/') {
          throw new AppError('BRIGHTSPACE_UNAVAILABLE', 'Brightspace down', 503, {
            brightspaceStatus: 503
          });
        }

        if (path === '/d2l/api/le/1.82/2/dropbox/folders/') {
          throw new AppError('BRIGHTSPACE_UNAVAILABLE', 'Brightspace down', 503, {
            brightspaceStatus: 503
          });
        }

        throw new Error(`Unexpected path ${path}`);
      })
    };

    const handler = await loadListUpcomingHandler(brightspace);

    await expect(handler({ days: 7 })).rejects.toThrow(
      'Failed to fetch upcoming assignments for all courses.'
    );
  });
});
