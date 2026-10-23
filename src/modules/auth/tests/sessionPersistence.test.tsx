import assert from 'node:assert/strict';

import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { AuthProvider, useAuth } from '@/modules/auth/context/AuthContext';
import { authenticatedFetch } from '@/shared/api';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('@/shared/userSettings', () => ({
  hydrateUserPreferences: vi.fn(),
  resetUserPreferences: vi.fn(),
}));
vi.mock('@/shared/chatDrafts', () => ({
  hydrateChatDrafts: vi.fn(),
  resetChatDrafts: vi.fn(),
}));

const makeToken = (issuedAt: number) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ iat: issuedAt, exp: issuedAt + 3600 })}.signature`;
};
const currentToken = () => makeToken(Math.floor(Date.now() / 1000) - 60);

function Probe() {
  const { user, isLoading, error } = useAuth();
  return <div data-testid="state">{JSON.stringify({ username: user?.username, isLoading, error })}</div>;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

for (const failure of ['status-503', 'user-503', 'user-html']) {
  test(`bootstrap ${failure} preserves the stored login`, async () => {
    const token = currentToken();
    localStorage.setItem('auth-token', token);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/auth/status') {
        return failure === 'status-503'
          ? new Response('Unavailable', { status: 503 })
          : new Response(JSON.stringify({ needsSetup: false }));
      }
      return failure === 'user-503'
        ? new Response('Unavailable', { status: 503 })
        : new Response('<html>Gateway error</html>');
    }));

    const view = render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => {
      const state = JSON.parse(view.getByTestId('state').textContent!);
      assert.equal(state.isLoading, false);
      assert.equal(state.error, 'errors.authStatusCheckFailed');
    });
    assert.equal(localStorage.getItem('auth-token'), token);
  });
}

test('a rejected current token still expires the session', async () => {
  localStorage.setItem('auth-token', currentToken());
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/auth/status'
    ? new Response(JSON.stringify({ needsSetup: false }))
    : new Response('{}', { status: 401, headers: { 'X-Auth-Error': 'invalid-token' } })));

  const view = render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => {
    const state = JSON.parse(view.getByTestId('state').textContent!);
    assert.equal(state.isLoading, false);
    assert.equal(state.error, 'errors.sessionExpired');
    assert.equal(localStorage.getItem('auth-token'), null);
  });
});

test('token renewal keeps the user mounted without repeating bootstrap', async () => {
  localStorage.setItem('auth-token', currentToken());
  const next = makeToken(Math.floor(Date.now() / 1000));
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/auth/status') return new Response(JSON.stringify({ needsSetup: false }));
    if (url === '/api/auth/user') return new Response(JSON.stringify({ user: { username: 'test-user' } }));
    if (url === '/api/projects') return new Response('{}', { headers: { 'X-Refreshed-Token': next } });
    return new Response(JSON.stringify({ hasCompletedOnboarding: true }));
  });
  vi.stubGlobal('fetch', fetchMock);

  const view = render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => assert.equal(JSON.parse(view.getByTestId('state').textContent!).isLoading, false));
  await authenticatedFetch('/api/projects');
  await waitFor(() => assert.equal(localStorage.getItem('auth-token'), next));
  assert.equal(JSON.parse(view.getByTestId('state').textContent!).username, 'test-user');
  assert.equal(fetchMock.mock.calls.filter(([url]) => url === '/api/auth/user').length, 1);
});
