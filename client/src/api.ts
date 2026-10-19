const API_BASE: string = import.meta.env.VITE_API_URL ?? '';
const TOKEN_KEY = 'concord.token';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function api<T = void>(path: string, opts: { method?: Method; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = token;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API_BASE}/api${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.message ?? `Erro ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** POSTs raw bytes (e.g. PCM audio). Fire-and-forget friendly: resolves to the HTTP status. */
export async function apiRaw(path: string, body: ArrayBuffer): Promise<number> {
  const token = getToken();
  const res = await fetch(`${API_BASE}/api${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: token } : {}), 'Content-Type': 'application/octet-stream' },
    body,
  });
  return res.status;
}

export function fileUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith('/') ? API_BASE + url : url;
}

export function gatewayUrl(): string {
  const base = API_BASE || window.location.origin;
  return base.replace(/^http/, 'ws') + '/gateway';
}
