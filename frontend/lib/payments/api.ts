/** Errors from this app's own API routes, in the shape the routes return them. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Calls one of this app's API routes. Throws ApiError with the route's own code and message. */
export async function apiRequest<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  { fetchImpl = fetch, signal }: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "NETWORK", "Could not reach the app server. Check your connection.");
  }

  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const e = (json ?? {}) as { error?: string; message?: string; details?: Record<string, unknown> };
    throw new ApiError(response.status, e.error ?? "ERROR", e.message ?? "Something went wrong.", e.details ?? {});
  }
  return json as T;
}
