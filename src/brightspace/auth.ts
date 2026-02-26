import { fetch } from 'undici';

import { USER_AGENT } from '../core/meta.js';
import { sleep } from '../core/async.js';

export interface BrightspaceAuthStrategy {
  getAuthorizationHeader(): Promise<string>;
  handleUnauthorized(): Promise<boolean>;
}

interface OAuthOptions {
  authHost: string;
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken: string;
}

class StaticAccessTokenAuth implements BrightspaceAuthStrategy {
  constructor(private readonly token: string) {}

  async getAuthorizationHeader(): Promise<string> {
    return `Bearer ${this.token}`;
  }

  async handleUnauthorized(): Promise<boolean> {
    return false;
  }
}

class OAuthTokenAuth implements BrightspaceAuthStrategy {
  private accessToken?: string;
  private readonly authHost: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken: string;
  private refreshing: Promise<void> | null = null;
  private tokenExpiresAt: number | null = null;

  constructor(options: OAuthOptions) {
    this.authHost = options.authHost;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.refreshToken = options.refreshToken;
    this.accessToken = options.accessToken;
  }

  async getAuthorizationHeader(): Promise<string> {
    if (this.shouldRefreshSoon()) {
      await this.refreshTokenPair();
    }

    if (!this.accessToken) {
      await this.refreshTokenPair();
    }

    if (!this.accessToken) {
      throw new Error('Missing Brightspace access token after refresh.');
    }

    return `Bearer ${this.accessToken}`;
  }

  async handleUnauthorized(): Promise<boolean> {
    await this.refreshTokenPair(true);
    return Boolean(this.accessToken);
  }

  private shouldRefreshSoon(): boolean {
    if (!this.tokenExpiresAt) {
      return false;
    }

    const refreshThreshold = this.tokenExpiresAt - 60_000;
    return Date.now() >= refreshThreshold;
  }

  private async refreshTokenPair(force = false): Promise<void> {
    if (this.refreshing) {
      await this.refreshing;
      return;
    }

    this.refreshing = this.performRefresh(force);

    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async performRefresh(force: boolean): Promise<void> {
    const url = new URL('/core/connect/token', this.authHost);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT
      },
      body: body.toString()
    });

    if (!response.ok) {
      if (!force) {
        await sleep(300);
      }
      throw new Error(`Brightspace OAuth token refresh failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    this.accessToken = payload.access_token;

    if (payload.refresh_token) {
      this.refreshToken = payload.refresh_token;
    }

    if (payload.expires_in && Number.isFinite(payload.expires_in)) {
      this.tokenExpiresAt = Date.now() + Math.max(payload.expires_in - 60, 0) * 1000;
    } else {
      this.tokenExpiresAt = null;
    }
  }
}

export function createAuthStrategy(options: {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  authHost: string;
}): BrightspaceAuthStrategy {
  if (options.accessToken && !(options.clientId && options.clientSecret && options.refreshToken)) {
    return new StaticAccessTokenAuth(options.accessToken);
  }

  if (options.clientId && options.clientSecret && options.refreshToken) {
    return new OAuthTokenAuth({
      authHost: options.authHost,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      accessToken: options.accessToken,
      refreshToken: options.refreshToken
    });
  }

  throw new Error('No Brightspace authentication method configured.');
}
