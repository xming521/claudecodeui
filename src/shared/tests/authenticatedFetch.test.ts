import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { AUTH_SESSION_EXPIRED_EVENT, AUTH_TOKEN_REFRESHED_EVENT } from '@/shared/authToken';

/**
 * The consumer side of the JWT lifecycle that authToken.ts owns.
 * authToken.test.ts covers the primitives; nothing covered the request helper
 * that calls them on every API call in the app.
 *
 * IS_PLATFORM is resolved at module scope from a build-time flag and decides
 * whether the app authenticates with a bearer token at all, so each test loads
 * a fresh copy of api.ts with the flag stubbed. Reading the ambient value would
 * make these tests agree with whatever .env the machine happens to have — this
 * workspace has VITE_IS_PLATFORM=true, CI does not.
 */

const loadFetch = async (isPlatform: boolean) => {
  vi.stubEnv('VITE_IS_PLATFORM', isPlatform ? 'true' : 'false');
  vi.resetModules();
  return (await import('@/shared/api')).authenticatedFetch;
};

const makeToken = (payload: Record<string, unknown>) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};

const liveToken = () => {
  const now = Math.floor(Date.now() / 1000);
  return makeToken({ iat: now, exp: now + 600 });
};

const expiredToken = () => {
  const now = Math.floor(Date.now() / 1000);
  return makeToken({ iat: now - 7200, exp: now - 3600 });
};

let lastInit: RequestInit | undefined;

// The status matters as much as the headers: a response served from cache
// replays the headers it was stored with while surfacing its stored status, so
// the same header set has to mean different things depending on whether the
// server actually rejected *this* request.
const respondWith = (headers: Record<string, string> = {}, status = 200) => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    lastInit = init;
    return new Response('{}', { status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const sentHeaders = () => Object.fromEntries(new Headers(lastInit?.headers).entries());

beforeEach(() => {
  localStorage.clear();
  lastInit = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test('a live token is sent as a bearer credential', async () => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  respondWith();

  await (await loadFetch(false))('/api/projects');

  assert.equal(sentHeaders().authorization, `Bearer ${token}`);
});

test('platform builds send no bearer token, because the session is a cookie', async () => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  respondWith();

  await (await loadFetch(true))('/api/projects');

  assert.equal('authorization' in sentHeaders(), false);
});

test('an expired token is never put on the wire', async () => {
  // getStoredAuthToken drops it rather than handing it over, so the request goes
  // out unauthenticated and the app is told the session is gone.
  localStorage.setItem('auth-token', expiredToken());
  let expiries = 0;
  const onExpired = () => {
    expiries += 1;
  };
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  respondWith();

  await (await loadFetch(false))('/api/projects');

  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  assert.equal('authorization' in sentHeaders(), false);
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.equal(expiries, 1);
});

test('no token means no Authorization header at all', async () => {
  respondWith();

  await (await loadFetch(false))('/api/projects');

  assert.equal('authorization' in sentHeaders(), false);
});

test('a JSON body is labelled as JSON', async () => {
  respondWith();

  await (await loadFetch(false))('/api/projects', { method: 'POST', body: '{"a":1}' });

  assert.equal(sentHeaders()['content-type'], 'application/json');
});

test('a FormData body is left for the browser to label', async () => {
  // Setting Content-Type by hand drops the multipart boundary and the upload
  // arrives unparseable.
  respondWith();

  await (await loadFetch(false))('/api/upload', { method: 'POST', body: new FormData() });

  assert.equal('content-type' in sentHeaders(), false);
});

test('a caller header wins over the default', async () => {
  respondWith();

  await (await loadFetch(false))('/api/projects', {
    method: 'POST',
    body: 'raw',
    headers: { 'Content-Type': 'text/plain' },
  });

  assert.equal(sentHeaders()['content-type'], 'text/plain');
});

test('a refreshed token on the response replaces the stored one', async () => {
  const now = Math.floor(Date.now() / 1000);
  localStorage.setItem('auth-token', makeToken({ iat: now - 60, exp: now + 540 }));
  const rotated = liveToken();
  let announced: string | null = null;
  const onRefresh = (event: Event) => {
    announced = (event as CustomEvent<string>).detail;
  };
  window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, onRefresh);
  respondWith({ 'X-Refreshed-Token': rotated });

  await (await loadFetch(false))('/api/projects');

  window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, onRefresh);
  assert.equal(localStorage.getItem('auth-token'), rotated);
  assert.equal(announced, rotated);
});

test('an auth error on the response ends the session', async () => {
  localStorage.setItem('auth-token', liveToken());
  let expiries = 0;
  const onExpired = () => {
    expiries += 1;
  };
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  respondWith({ 'X-Auth-Error': 'invalid-token' }, 401);

  await (await loadFetch(false))('/api/projects');

  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  assert.equal(expiries, 1);
  assert.equal(localStorage.getItem('auth-token'), null);
});

test('an auth error replayed by a cached response does not end the session', async () => {
  const live = liveToken();
  localStorage.setItem('auth-token', live);
  let expiries = 0;
  const onExpired = () => {
    expiries += 1;
  };
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  // A cached response replays the headers it was stored with, under its stored
  // status — a revalidated 200, not the 304 from the wire. Treating that stale
  // X-Auth-Error as a rejection signed the user out on every start.
  respondWith({ 'X-Auth-Error': 'invalid' }, 200);

  await (await loadFetch(false))('/api/projects');

  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  assert.equal(expiries, 0);
  assert.equal(localStorage.getItem('auth-token'), live);
});

test('an expired refreshed token does not replace the stored one', async () => {
  const live = liveToken();
  localStorage.setItem('auth-token', live);
  // Same replay problem on the refresh path, and the damaging one: a cached
  // X-Refreshed-Token from an old session overwrote a seconds-old sign-in,
  // which the next read then discarded as expired.
  respondWith({ 'X-Refreshed-Token': expiredToken() });

  await (await loadFetch(false))('/api/projects');

  assert.equal(localStorage.getItem('auth-token'), live);
});

test('requests bypass the HTTP cache', async () => {
  localStorage.setItem('auth-token', liveToken());
  respondWith();

  await (await loadFetch(false))('/api/projects');

  // Without this, a cached response replays another session's auth headers.
  assert.equal(lastInit?.cache, 'no-store');
});

test('an ordinary response leaves the stored token alone', async () => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  respondWith();

  await (await loadFetch(false))('/api/projects');

  assert.equal(localStorage.getItem('auth-token'), token);
});

test('API requests bypass existing cached responses even if a caller requests caching', async () => {
  respondWith();
  await (await loadFetch(false))('/api/projects', { cache: 'force-cache' });
  assert.equal(lastInit?.cache, 'no-store');
});

test('a late unauthenticated 401 cannot clear a newly established login', async () => {
  const token = liveToken();
  let expiries = 0;
  const onExpired = () => { expiries += 1; };
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  vi.stubGlobal('fetch', vi.fn(async () => {
    localStorage.setItem('auth-token', token);
    return new Response('{}', { status: 401, headers: { 'X-Auth-Error': 'invalid-token' } });
  }));

  await (await loadFetch(false))('/api/plugins');

  window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, onExpired);
  assert.equal(expiries, 0);
  assert.equal(localStorage.getItem('auth-token'), token);
});

test('a late 401 for an earlier token cannot clear a newer login', async () => {
  const now = Math.floor(Date.now() / 1000);
  localStorage.setItem('auth-token', makeToken({ iat: now - 60, exp: now + 540 }));
  const token = liveToken();
  vi.stubGlobal('fetch', vi.fn(async () => {
    localStorage.setItem('auth-token', token);
    return new Response('{}', { status: 401, headers: { 'X-Auth-Error': 'session-expired' } });
  }));

  await (await loadFetch(false))('/api/projects');

  assert.equal(localStorage.getItem('auth-token'), token);
});

test('an overridden bearer credential does not clear the stored session', async () => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  respondWith({ 'X-Auth-Error': 'invalid-token' }, 401);

  await (await loadFetch(false))('/api/projects', { headers: { authorization: 'Bearer other' } });

  assert.equal(sentHeaders().authorization, 'Bearer other');
  assert.equal(localStorage.getItem('auth-token'), token);
});

test('a cached expired refresh header does not replace a live login', async () => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  respondWith({ 'X-Refreshed-Token': expiredToken() });

  await (await loadFetch(false))('/api/projects');

  assert.equal(localStorage.getItem('auth-token'), token);
});

test('a transient server failure does not end the session', async () => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  respondWith({}, 503);

  await (await loadFetch(false))('/api/auth/user');

  assert.equal(localStorage.getItem('auth-token'), token);
});

test('platform authentication errors do not remove an unrelated stored bearer', async () => {
  const token = liveToken();
  localStorage.setItem('auth-token', token);
  respondWith({ 'X-Auth-Error': 'invalid-token' }, 401);

  await (await loadFetch(true))('/api/projects');

  assert.equal(localStorage.getItem('auth-token'), token);
});
