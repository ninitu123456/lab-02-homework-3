import type { ApiErrorBody } from '../shared/types.js';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.json() as ApiErrorBody;
    throw new ApiError(body.error?.code || 'HTTP_ERROR', body.error?.message || 'Không thể thực hiện yêu cầu.', response.status);
  }
  return response.json() as Promise<T>;
}
