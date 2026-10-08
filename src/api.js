/**
 * Thrown specifically on HTTP 401 — the project token is invalid or was
 * revoked (e.g. the project was deleted). Distinct from a generic network
 * or server error: callers should treat this as "stop managing this
 * project", not as "retry later from cache".
 */
export class UnauthorizedError extends Error {}

/**
 * fetchImpl is injectable so this can be unit-tested without a real
 * network call — mirrors the exec-injection pattern in migrate.js.
 */
export async function fetchManifest(apiBase, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${apiBase}/manifest`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) {
    throw new UnauthorizedError('Invalid or revoked project token.');
  }

  if (!res.ok) {
    throw new Error(`Manifest request failed: ${res.status}`);
  }

  return res.json();
}