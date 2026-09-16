/**
 * The single place the browser talks to the backend.
 *
 * The frontend never touches the database and holds no secret. It calls our own
 * REST API with a short-lived bearer token, and the API decides what this user
 * is allowed to see.
 */

/**
 * Normalises the configured origin so a value with or without the `/api`
 * suffix, or with a trailing slash, all resolve to the same base. The most
 * common deployment mistake is setting only the host.
 */
export function resolveApiBase(configured: string | undefined): string {
  const trimmed = (configured ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') return 'http://localhost:4000/api';
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

const BASE_URL = resolveApiBase(import.meta.env.VITE_API_BASE_URL);

/** Kept in memory only — never localStorage, so an XSS payload cannot read it. */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { field: string; message: string }[]
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Skips the refresh-and-retry dance for the refresh call itself. */
  skipRefresh?: boolean;
}

async function refreshSession(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) return false;
    const payload = await response.json();
    accessToken = payload.data.accessToken;
    return true;
  } catch {
    return false;
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, skipRefresh = false } = options;

  const send = async (): Promise<Response> =>
    fetch(`${BASE_URL}${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let response: Response;
  try {
    response = await send();
  } catch {
    // fetch only rejects on a network-level failure.
    throw new ApiClientError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection.');
  }

  // An expired 15-minute access token is invisible to the user: refresh once
  // using the httpOnly cookie and replay the original request.
  if (response.status === 401 && !skipRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await send();
    }
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiClientError(response.status, 'UNEXPECTED_RESPONSE', 'Unexpected server response.');
    }
    return (await response.text()) as T;
  }

  const payload = await response.json();

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiClientError(
      response.status,
      error.code ?? 'UNKNOWN',
      error.message ?? 'Something went wrong.',
      error.details
    );
  }

  return payload as T;
}

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta?: { page: number; limit: number; total: number; totalPages: number };
}

export const api = {
  get: <T>(path: string) => apiRequest<ApiEnvelope<T>>(path),
  post: <T>(path: string, body?: unknown) => apiRequest<ApiEnvelope<T>>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<ApiEnvelope<T>>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<ApiEnvelope<T>>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiRequest<ApiEnvelope<T>>(path, { method: 'DELETE' }),
  raw: apiRequest,
};

/** Builds a query string, dropping empty filters so the URL stays readable. */
export function queryString(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
