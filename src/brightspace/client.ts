import { fetch, type Response } from 'undici';

import { sleep } from '../core/async.js';
import { brightspaceError, brightspaceTimeoutError, unknownError } from '../core/errors.js';
import { USER_AGENT } from '../core/meta.js';
import { BrightspaceAuthStrategy, createAuthStrategy } from './auth.js';

export interface BrightspaceClientOptions {
  baseUrl: string;
  authHost: string;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  maxRetries?: number;
  httpTimeoutMs?: number;
  lpVersion: string;
  leVersion: string;
}

export interface BrightspaceRequestOptions {
  signal?: AbortSignal;
}

export interface BrightspaceResult<T> {
  data: T;
  status: number;
  requestId?: string;
  requestIds?: string[];
}

interface PagedResultSet<T> {
  PagingInfo?: {
    Bookmark?: string | null;
    HasMoreItems?: boolean;
  } | null;
  Items?: T[] | null;
}

interface ObjectListPage<T> {
  Next?: string | null;
  Objects?: T[] | null;
}

export class BrightspaceClient {
  private readonly baseUrl: string;
  private readonly auth: BrightspaceAuthStrategy;
  private readonly maxRetries: number;
  private readonly httpTimeoutMs: number;
  private readonly lpVersion: string;
  private readonly leVersion: string;

  constructor(options: BrightspaceClientOptions) {
    this.baseUrl = options.baseUrl;
    this.maxRetries = options.maxRetries ?? 3;
    this.httpTimeoutMs = options.httpTimeoutMs ?? 15000;
    this.lpVersion = options.lpVersion;
    this.leVersion = options.leVersion;

    this.auth = createAuthStrategy({
      authHost: options.authHost,
      accessToken: options.accessToken,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      refreshToken: options.refreshToken
    });
  }

  lp(path: string): string {
    return `/d2l/api/lp/${this.lpVersion}${path}`;
  }

  le(path: string): string {
    return `/d2l/api/le/${this.leVersion}${path}`;
  }

  resolveUrl(path: string, params?: Record<string, unknown>): URL {
    return this.buildUrl(path, params);
  }

  async get<T>(
    path: string,
    params?: Record<string, unknown>,
    options?: BrightspaceRequestOptions
  ): Promise<BrightspaceResult<T>> {
    const url = this.buildUrl(path, params);
    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      signal: options?.signal
    });

    return this.handleResponse<T>(response);
  }

  async post<T>(
    path: string,
    body: unknown,
    options?: BrightspaceRequestOptions
  ): Promise<BrightspaceResult<T>> {
    const url = this.buildUrl(path);
    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options?.signal
    });

    return this.handleResponse<T>(response);
  }

  async getPagedResultSet<T>(
    path: string,
    params?: Record<string, unknown>,
    options?: BrightspaceRequestOptions
  ): Promise<BrightspaceResult<T[]>> {
    const results: T[] = [];
    const requestIds: string[] = [];
    let status = 200;
    let bookmark: string | null | undefined = undefined;

    do {
      const response = await this.fetchWithRetry(
        this.buildUrl(path, { ...params, bookmark: bookmark ?? undefined }),
        {
          method: 'GET',
          signal: options?.signal
        }
      );

      status = response.status;
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (requestId) {
        requestIds.push(requestId);
      }

      const { ok, payload } = await this.parsePayload(response);

      if (!ok) {
        const message = extractBrightspaceMessage(payload);
        throw brightspaceError(response.status, requestId, message, payload);
      }

      const normalized = payload as PagedResultSet<T> | null;
      const items = normalized?.Items ?? [];
      if (!Array.isArray(items)) {
        throw unknownError('Expected Brightspace PagedResultSet.Items to be an array.', payload);
      }

      results.push(...items);
      const pagingInfo = normalized?.PagingInfo ?? undefined;
      const hasMore = Boolean(pagingInfo?.HasMoreItems);
      bookmark = hasMore ? pagingInfo?.Bookmark ?? null : null;
    } while (bookmark);

    return {
      data: results,
      status,
      requestId: requestIds.at(-1),
      requestIds: requestIds.length ? requestIds : undefined
    };
  }

  async getObjectListPage<T>(
    path: string,
    params?: Record<string, unknown>,
    options?: BrightspaceRequestOptions
  ): Promise<BrightspaceResult<T[]>> {
    const results: T[] = [];
    const requestIds: string[] = [];
    let status = 200;
    let nextUrl: URL | null = this.buildUrl(path, params);

    while (nextUrl) {
      const response = await this.fetchWithRetry(nextUrl, {
        method: 'GET',
        signal: options?.signal
      });

      status = response.status;
      const requestId = response.headers.get('x-request-id') ?? undefined;
      if (requestId) {
        requestIds.push(requestId);
      }

      const { ok, payload } = await this.parsePayload(response);

      if (!ok) {
        const message = extractBrightspaceMessage(payload);
        throw brightspaceError(response.status, requestId, message, payload);
      }

      const normalized = payload as ObjectListPage<T> | null;
      const objects = normalized?.Objects ?? [];
      if (!Array.isArray(objects)) {
        throw unknownError('Expected Brightspace ObjectListPage.Objects to be an array.', payload);
      }

      results.push(...objects);

      const next = normalized?.Next;
      if (!next) {
        nextUrl = null;
        continue;
      }

      try {
        nextUrl = new URL(next, this.baseUrl);
      } catch {
        nextUrl = null;
      }
    }

    return {
      data: results,
      status,
      requestId: requestIds.at(-1),
      requestIds: requestIds.length ? requestIds : undefined
    };
  }

  private buildUrl(path: string, params?: Record<string, unknown>): URL {
    const url = new URL(path, this.baseUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
          continue;
        }

        if (Array.isArray(value)) {
          for (const entry of value) {
            url.searchParams.append(key, String(entry));
          }
        } else if (value instanceof Date) {
          url.searchParams.set(key, value.toISOString());
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url;
  }

  private async fetchWithRetry(
    url: URL,
    init: { method: string; body?: string; signal?: AbortSignal },
    attempt = 0
  ): Promise<Response> {
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', USER_AGENT);
    headers.set('Authorization', await this.auth.getAuthorizationHeader());

    if (init.body) {
      headers.set('Content-Type', 'application/json');
    }

    const timeout = this.createTimeoutSignal(init.signal);

    try {
      const response = await fetch(url, {
        ...init,
        headers,
        signal: timeout.signal
      });

      if (response.status === 401) {
        const refreshed = await this.auth.handleUnauthorized();
        if (refreshed && attempt < this.maxRetries) {
          return this.fetchWithRetry(url, init, attempt + 1);
        }
      }

      if (shouldRetry(response.status) && attempt < this.maxRetries) {
        await sleep(this.retryDelay(attempt, response.headers.get('retry-after')));
        return this.fetchWithRetry(url, init, attempt + 1);
      }

      return response;
    } catch (error) {
      if (isAbortError(error)) {
        if (timeout.didTimeout) {
          if (attempt < this.maxRetries) {
            await sleep(this.retryDelay(attempt));
            return this.fetchWithRetry(url, init, attempt + 1);
          }

          throw brightspaceTimeoutError(this.httpTimeoutMs, url.toString(), {
            attempts: attempt + 1
          });
        }

        throw error;
      }

      if (attempt >= this.maxRetries) {
        throw error;
      }

      await sleep(this.retryDelay(attempt));
      return this.fetchWithRetry(url, init, attempt + 1);
    } finally {
      timeout.clear();
    }
  }

  private async handleResponse<T>(response: Response): Promise<BrightspaceResult<T>> {
    const { ok, payload } = await this.parsePayload(response);
    const requestId = response.headers.get('x-request-id') ?? undefined;

    if (!ok) {
      const message = extractBrightspaceMessage(payload);
      throw brightspaceError(response.status, requestId, message, payload);
    }

    return {
      data: payload as T,
      status: response.status,
      requestId
    };
  }

  private async parsePayload(
    response: Response
  ): Promise<{ ok: boolean; payload: unknown }> {
    const text = await response.text();

    if (!text) {
      return { ok: response.ok, payload: null };
    }

    try {
      return { ok: response.ok, payload: JSON.parse(text) };
    } catch (error) {
      if (response.ok) {
        throw unknownError('Brightspace returned an unexpected payload format.', {
          contentType: response.headers.get('content-type'),
          body: text
        });
      }

      return { ok: response.ok, payload: text };
    }
  }

  private retryDelay(attempt: number, retryAfter?: string | null): number {
    const parsedRetryAfter = parseRetryAfter(retryAfter);

    if (parsedRetryAfter !== null) {
      return parsedRetryAfter;
    }

    const base = 500 * Math.pow(2, attempt);
    const jitter = base * (0.5 + Math.random());
    return Math.min(5000, jitter);
  }

  private createTimeoutSignal(parent?: AbortSignal): {
    signal: AbortSignal;
    didTimeout: boolean;
    clear: () => void;
  } {
    const controller = new AbortController();
    let didTimeout = false;
    let timeoutId: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    if (this.httpTimeoutMs > 0) {
      timeoutId = setTimeout(() => {
        didTimeout = true;
        controller.abort();
      }, this.httpTimeoutMs);
    }

    if (parent) {
      if (parent.aborted) {
        controller.abort(parent.reason);
      } else {
        abortListener = () => controller.abort(parent.reason);
        parent.addEventListener('abort', abortListener, { once: true });
      }
    }

    return {
      signal: controller.signal,
      get didTimeout() {
        return didTimeout;
      },
      clear: () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (parent && abortListener) {
          parent.removeEventListener('abort', abortListener);
        }
      }
    };
  }
}

function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const anyError = error as { name?: string; code?: string };
  return anyError.name === 'AbortError' || anyError.code === 'UND_ERR_ABORTED';
}

function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) {
    return null;
  }

  const seconds = Number(header);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function extractBrightspaceMessage(payload: unknown): string | undefined {
  if (!payload) {
    return undefined;
  }

  if (typeof payload === 'string') {
    return payload;
  }

  if (Array.isArray(payload)) {
    const [first] = payload;
    return extractBrightspaceMessage(first);
  }

  if (typeof payload !== 'object') {
    return undefined;
  }

  const anyPayload = payload as Record<string, unknown>;

  if (typeof anyPayload.message === 'string') {
    return anyPayload.message;
  }

  if (typeof anyPayload.Message === 'string') {
    return anyPayload.Message;
  }

  if (typeof anyPayload.ErrorMessage === 'string') {
    return anyPayload.ErrorMessage;
  }

  if (Array.isArray(anyPayload.Errors) && anyPayload.Errors.length > 0) {
    const [first] = anyPayload.Errors;
    if (typeof first === 'string') {
      return first;
    }
    if (first && typeof first === 'object') {
      const normalized = first as Record<string, unknown>;
      if (typeof normalized.Message === 'string') {
        return normalized.Message;
      }
      if (typeof normalized.ErrorMessage === 'string') {
        return normalized.ErrorMessage;
      }
    }
  }

  return undefined;
}
