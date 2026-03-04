import { z } from 'zod';

const envSchema = z
  .object({
    BRIGHTSPACE_BASE_URL: z.string().url(),
    BRIGHTSPACE_AUTH_HOST: z
      .string()
      .url()
      .optional()
      .transform((value) => value?.trim() || 'https://auth.brightspace.com'),
    BRIGHTSPACE_ACCESS_TOKEN: z.string().trim().optional(),
    BRIGHTSPACE_CLIENT_ID: z.string().trim().optional(),
    BRIGHTSPACE_CLIENT_SECRET: z.string().trim().optional(),
    BRIGHTSPACE_REFRESH_TOKEN: z.string().trim().optional(),
    BRIGHTSPACE_HTTP_TIMEOUT_MS: z
      .preprocess(
        (value) => {
          if (value === undefined || value === null || value === '') {
            return undefined;
          }
          return value;
        },
        z.coerce.number().int().min(1000).max(120000).optional()
      )
      .transform((value) => value ?? 15000),
    BRIGHTSPACE_LP_VERSION: z
      .string()
      .optional()
      .transform((value) => value?.trim() || '1.49'),
    BRIGHTSPACE_LE_VERSION: z
      .string()
      .optional()
      .transform((value) => value?.trim() || '1.82'),
    MCP_BEARER: z.string().trim().min(1, 'MCP_BEARER is required'),
    MCP_RATE_LIMIT_WINDOW_MS: numberFromEnv(60_000),
    MCP_RATE_LIMIT_MAX: numberFromEnv(30),
    MCP_MESSAGES_RATE_LIMIT_WINDOW_MS: numberFromEnv(60_000),
    MCP_MESSAGES_RATE_LIMIT_MAX: numberFromEnv(120),
    MCP_SESSION_TTL_MS: numberFromEnv(15 * 60_000),
    MCP_SESSION_CLEANUP_INTERVAL_MS: numberFromEnv(60_000),
    MCP_MAX_SESSIONS: optionalPositiveInt(),
    MCP_SSE_HEARTBEAT_MS: numberFromEnv(25_000),
    BRIGHTSPACE_TIMEZONE: z
      .string()
      .optional()
      .transform((value) => value?.trim() || 'UTC')
      .pipe(
        z
          .string()
          .trim()
          .refine((value) => isValidTimeZone(value), {
            message: 'BRIGHTSPACE_TIMEZONE must be a valid IANA time zone name.'
          })
      )
  })
  .superRefine((value, ctx) => {
    const hasAccessToken = Boolean(value.BRIGHTSPACE_ACCESS_TOKEN);
    const hasOAuth =
      Boolean(value.BRIGHTSPACE_CLIENT_ID) &&
      Boolean(value.BRIGHTSPACE_CLIENT_SECRET) &&
      Boolean(value.BRIGHTSPACE_REFRESH_TOKEN);

    if (!hasAccessToken && !hasOAuth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Provide either BRIGHTSPACE_ACCESS_TOKEN or full OAuth credentials (client id/secret and refresh token).',
        path: ['BRIGHTSPACE_ACCESS_TOKEN']
      });
    }
  });

export type AppEnv = z.infer<typeof envSchema> & {
  brightspaceBaseUrl: string;
  brightspaceAuthHost: string;
  brightspaceTimezone: string;
  brightspaceHttpTimeoutMs: number;
  brightspaceLpVersion: string;
  brightspaceLeVersion: string;
};

function numberFromEnv(defaultValue: number): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') {
        return defaultValue;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    },
    z.number().int().nonnegative()
  );
}

function optionalPositiveInt(): z.ZodType<number | undefined, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === '') {
        return undefined;
      }
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    },
    z.number().int().positive().optional()
  );
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch (error) {
    return false;
  }
}

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

let cachedEnv: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }

  const brightspaceBaseUrl = normalizeBaseUrl(parsed.data.BRIGHTSPACE_BASE_URL);
  const brightspaceAuthHost = normalizeBaseUrl(parsed.data.BRIGHTSPACE_AUTH_HOST);

  cachedEnv = {
    ...parsed.data,
    brightspaceBaseUrl,
    brightspaceAuthHost,
    brightspaceTimezone: parsed.data.BRIGHTSPACE_TIMEZONE,
    brightspaceHttpTimeoutMs: parsed.data.BRIGHTSPACE_HTTP_TIMEOUT_MS,
    brightspaceLpVersion: parsed.data.BRIGHTSPACE_LP_VERSION,
    brightspaceLeVersion: parsed.data.BRIGHTSPACE_LE_VERSION
  };

  return cachedEnv;
}

export function resetEnvCacheForTesting(): void {
  cachedEnv = null;
}
