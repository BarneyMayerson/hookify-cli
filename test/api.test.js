import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fetchManifest, UnauthorizedError } from '../src/api.js';

function fakeFetch(status, body) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('fetchManifest', () => {
  test('returns the parsed manifest on success', async () => {
    const manifest = { schema_version: 1, project: { id: 1, name: 'Acme' }, hooks: {} };
    const result = await fetchManifest('https://x/api/v1', 'tok', fakeFetch(200, manifest));
    assert.deepEqual(result, manifest);
  });

  test('throws UnauthorizedError specifically on 401', async () => {
    await assert.rejects(
      () => fetchManifest('https://x/api/v1', 'tok', fakeFetch(401, {})),
      UnauthorizedError,
    );
  });

  test('throws a plain Error (not UnauthorizedError) on other failures', async () => {
    await assert.rejects(
      () => fetchManifest('https://x/api/v1', 'tok', fakeFetch(500, {})),
      (err) => err instanceof Error && !(err instanceof UnauthorizedError),
    );
  });
});