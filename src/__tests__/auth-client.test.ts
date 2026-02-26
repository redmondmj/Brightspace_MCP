import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('undici', () => ({
  fetch: vi.fn()
}));

import { fetch } from 'undici';
import { createAuthStrategy } from '../brightspace/auth.js';
import { BrightspaceClient } from '../brightspace/client.js';

const fetchMock = vi.mocked(fetch);

function mockResponse(options: {
  status: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}): any {
  const headers = new Headers(options.headers);
  const ok = options.ok ?? (options.status >= 200 && options.status < 300);
  return {
    status: options.status,
    ok,
    headers,
    async json() {
      return options.json;
    },
    async text() {
      if (options.text !== undefined) {
        return options.text;
      }
      if (options.json === undefined) {
        return '';
      }
      return JSON.stringify(options.json);
    }
  } as unknown as Response;
}

afterEach(() => {
  fetchMock.mockReset();
});

describe('createAuthStrategy', () => {
  it('uses access token when provided', async () => {
    const auth = createAuthStrategy({
      authHost: 'https://auth.brightspace.com',
      accessToken: 'access-token'
    });

    await expect(auth.getAuthorizationHeader()).resolves.toBe('Bearer access-token');
    await expect(auth.handleUnauthorized()).resolves.toBe(false);
  });

  it('refreshes OAuth tokens when missing access token', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600
        }
      })
    );

    const auth = createAuthStrategy({
      authHost: 'https://auth.brightspace.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token'
    });

    await expect(auth.getAuthorizationHeader()).resolves.toBe('Bearer new-access');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://auth.brightspace.com/core/connect/token');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded'
    });
    expect(init?.body).toContain('grant_type=refresh_token');
    expect(init?.body).toContain('refresh_token=refresh-token');
    expect(init?.body).toContain('client_id=client-id');
    expect(init?.body).toContain('client_secret=client-secret');
  });
});

describe('BrightspaceClient', () => {
  it('builds URLs with array and date params', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse({
        status: 200,
        json: { ok: true }
      })
    );

    const client = new BrightspaceClient({
      baseUrl: 'https://brightspace.example.com',
      authHost: 'https://auth.brightspace.com',
      accessToken: 'access-token',
      lpVersion: '1.49',
      leVersion: '1.82'
    });

    await client.get('/d2l/api/lp/1.49/items', {
      include: ['a', 'b'],
      since: new Date('2024-01-01T00:00:00Z'),
      limit: 10,
      skip: undefined
    });

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.pathname).toBe('/d2l/api/lp/1.49/items');
    expect(parsed.searchParams.getAll('include')).toEqual(['a', 'b']);
    expect(parsed.searchParams.get('since')).toBe('2024-01-01T00:00:00.000Z');
    expect(parsed.searchParams.get('limit')).toBe('10');
    expect(parsed.searchParams.has('skip')).toBe(false);
  });

  it('paginates PagedResultSet results and returns request IDs', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          json: {
            PagingInfo: { HasMoreItems: true, Bookmark: 'next' },
            Items: [{ id: 1 }]
          },
          headers: {
            'x-request-id': 'req-1'
          }
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          json: {
            PagingInfo: { HasMoreItems: false, Bookmark: null },
            Items: [{ id: 2 }]
          },
          headers: {
            'x-request-id': 'req-2'
          }
        })
      );

    const client = new BrightspaceClient({
      baseUrl: 'https://brightspace.example.com',
      authHost: 'https://auth.brightspace.com',
      accessToken: 'access-token',
      lpVersion: '1.49',
      leVersion: '1.82'
    });

    const result = await client.getPagedResultSet<{ id: number }>(
      '/d2l/api/lp/1.49/items'
    );

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.requestIds).toEqual(['req-1', 'req-2']);
    expect(result.requestId).toBe('req-2');
  });

  it('paginates ObjectListPage results', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          json: { Next: '/d2l/api/lp/1.49/items?page=2', Objects: [{ id: 1 }] },
          headers: {
            'x-request-id': 'req-1'
          }
        })
      )
      .mockResolvedValueOnce(
        mockResponse({
          status: 200,
          json: { Next: null, Objects: [{ id: 2 }] },
          headers: {
            'x-request-id': 'req-2'
          }
        })
      );

    const client = new BrightspaceClient({
      baseUrl: 'https://brightspace.example.com',
      authHost: 'https://auth.brightspace.com',
      accessToken: 'access-token',
      lpVersion: '1.49',
      leVersion: '1.82'
    });

    const result = await client.getObjectListPage<{ id: number }>(
      '/d2l/api/lp/1.49/items'
    );

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.requestIds).toEqual(['req-1', 'req-2']);
    expect(result.requestId).toBe('req-2');
  });
});
