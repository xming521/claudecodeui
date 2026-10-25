import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Issue #582: when the chat socket dropped, nothing in the UI changed, so a
 * message typed during the outage was lost without the user noticing. The
 * provider now reports `connectionStatus`, which tells a lost connection
 * (`disconnected`) apart from the first handshake (`connecting`, which must not
 * flash a warning on every page load) and from the socket it swaps on purpose
 * when a stale page comes back (which must not read as lost either).
 *
 * A page back from the background checks its old socket with `chat.ping`
 * while a replacement opens. The old socket stays if it answers first.
 */

type FakeAuth = { user: { id: number } | null; token: string | null; isLoading: boolean };

// Mutable so a test can hand the provider a refreshed token or sign the user
// out. `user` keeps one identity throughout; a fresh object would rebuild
// `connect` on every render.
const AUTH = vi.hoisted(() => {
  const user = { id: 1 };
  return { user, current: { user, token: 'token-1', isLoading: false } as FakeAuth };
});

vi.mock('@/modules/auth', () => ({
  useAuth: () => AUTH.current,
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;

  sent: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  // A real socket closed by the page still fires `close`; firing it here means
  // a swap that forgot to detach its handler would be caught.
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  serverOpens() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverSends(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The network or the server ends the socket (or refuses the handshake). */
  serverDrops() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const { WebSocketProvider, useWebSocket } = await import('@/shared/context/WebSocketContext');

/** Every status the provider rendered, in order, so a one-render flash is caught too. */
let seen: string[] = [];
let isConnected: boolean | null = null;
/** The kind of every event the provider dispatched to subscribers. */
let events: string[] = [];

function RecordStatus() {
  const value = useWebSocket();
  seen.push(String(value.connectionStatus));
  useEffect(() => {
    isConnected = value.isConnected;
  });
  const { subscribe } = value;
  useEffect(() => subscribe((event) => {
    events.push(String(event.kind));
  }), [subscribe]);
  return null;
}

const renderProvider = () => render(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
const socket = (index: number) => FakeWebSocket.instances[index] as FakeWebSocket;
const lastStatus = () => seen[seen.length - 1];

let pageHidden = false;
/** The phone locks or switches apps (`true`), or the user comes back (`false`). */
const setPageHidden = (hidden: boolean) => {
  pageHidden = hidden;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  pageHidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => pageHidden });
  FakeWebSocket.instances = [];
  seen = [];
  isConnected = null;
  events = [];
  AUTH.current = { user: AUTH.user, token: 'token-1', isLoading: false };
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('the first handshake reads as connecting, never as a lost connection', () => {
  renderProvider();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false);

  act(() => socket(0).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('a dropped socket reads as disconnected through every failed retry, until one opens', () => {
  renderProvider();
  act(() => socket(0).serverOpens());

  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');
  assert.equal(isConnected, false);

  // The retry is still handshaking: the connection is not back yet.
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(lastStatus(), 'disconnected');

  // The server is still unreachable.
  act(() => socket(1).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 3);
  act(() => socket(2).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.equal(isConnected, true);
});

test('a first attempt that fails reads as disconnected', () => {
  renderProvider();
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  act(() => { vi.advanceTimersByTime(3000); });
  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('a token refresh keeps the open socket, and the next socket uses the new token', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());

  AUTH.current = { ...AUTH.current, token: 'token-2' };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);

  // The server checked the token when the socket opened; rotating it does not
  // cut the stream.
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(socket(0).readyState, FakeWebSocket.OPEN);
  assert.equal(lastStatus(), 'connected');

  act(() => socket(0).serverDrops());
  act(() => { vi.advanceTimersByTime(500); });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.match(socket(1).url, /token=token-2/);
});

test('signing out while the socket is down does not carry the drop into the next sign-in', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'disconnected');

  // The session expires (or the user signs out) during the outage.
  AUTH.current = { user: null, token: null, isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(lastStatus(), 'connecting', 'no connection is lost while nobody is signed in');
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect while signed out');

  // Signing in again starts a fresh handshake, which must not read as lost.
  seen = [];
  AUTH.current = { user: AUTH.user, token: 'token-2', isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.ok(!seen.includes('disconnected'), `statuses seen after sign-in: ${seen.join(', ')}`);
  assert.equal(lastStatus(), 'connecting');

  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
});

test('signing out while connected stops reporting a live connection', () => {
  const view = renderProvider();
  act(() => socket(0).serverOpens());
  assert.equal(isConnected, true);

  AUTH.current = { user: null, token: null, isLoading: false };
  view.rerender(<WebSocketProvider><RecordStatus /></WebSocketProvider>);
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the socket was closed on sign-out');
  assert.equal(lastStatus(), 'connecting');
  assert.equal(isConnected, false, 'isConnected no longer reports the closed socket as live');
});

test('an open socket that drops is retried after half a second', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => socket(0).serverDrops());

  act(() => { vi.advanceTimersByTime(499); });
  assert.equal(FakeWebSocket.instances.length, 1);
  act(() => { vi.advanceTimersByTime(1); });
  assert.equal(FakeWebSocket.instances.length, 2);
});

test('coming back after a long lock keeps the old socket when it answers first', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => setPageHidden(true));
  act(() => { vi.advanceTimersByTime(60_000); });
  act(() => setPageHidden(false));

  assert.deepEqual(socket(0).sent, [{ type: 'chat.ping' }], 'the old socket was asked');
  assert.equal(FakeWebSocket.instances.length, 2, 'a replacement started opening at once');

  // What the page missed arrives first, then the answer.
  act(() => socket(0).serverSends({ kind: 'stream_delta', sessionId: 's1', seq: 7 }));
  act(() => socket(0).serverSends({ kind: 'chat_pong' }));

  assert.equal(socket(0).readyState, FakeWebSocket.OPEN);
  assert.equal(socket(1).readyState, FakeWebSocket.CLOSED, 'the replacement was dropped');
  assert.equal(lastStatus(), 'connected');
  assert.deepEqual(events, ['stream_delta'], 'no catch-up, and the answer itself is not dispatched');
  act(() => { vi.advanceTimersByTime(10_000); });
  assert.equal(FakeWebSocket.instances.length, 2, 'nothing else was opened');
  assert.equal(socket(0).readyState, FakeWebSocket.OPEN, 'the deadline did not drop the kept socket');
});

test('coming back after a long lock swaps to the replacement when it opens first', () => {
  renderProvider();
  act(() => socket(0).serverOpens());

  // The server dropped the suspended page, but the page has not heard yet.
  act(() => setPageHidden(true));
  act(() => { vi.advanceTimersByTime(60_000); });
  seen = [];
  act(() => setPageHidden(false));
  assert.equal(isConnected, true, 'the old socket still serves while it is checked');

  // A replacement hears nothing the page uses before it takes over.
  act(() => socket(1).serverSends({ kind: 'session_upserted' }));
  assert.deepEqual(events, []);

  act(() => socket(1).serverOpens());
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'the stale one was closed');
  assert.equal(isConnected, true);
  assert.deepEqual(events, ['websocket_reconnected'], 'the page catches up');
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);

  // A late answer on the closed socket changes nothing, and no retry is pending.
  act(() => { vi.advanceTimersByTime(10_000); });
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(socket(1).readyState, FakeWebSocket.OPEN);
});

test('an old socket that closes while being checked leaves the replacement to take over', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => setPageHidden(true));
  act(() => { vi.advanceTimersByTime(60_000); });
  act(() => setPageHidden(false));

  act(() => socket(0).serverDrops());
  assert.equal(lastStatus(), 'connecting');
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2, 'no retry on top of the replacement');

  act(() => socket(1).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.ok(!seen.includes('disconnected'), `statuses seen: ${seen.join(', ')}`);
});

test('an old socket that never answers is dropped after five seconds while the replacement retries', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => setPageHidden(true));
  act(() => { vi.advanceTimersByTime(60_000); });
  act(() => setPageHidden(false));

  // The network is still waking: the replacement fails and is retried.
  act(() => socket(1).serverDrops());
  assert.equal(lastStatus(), 'connected', 'the old socket may still answer');
  act(() => { vi.advanceTimersByTime(500); });
  assert.equal(FakeWebSocket.instances.length, 3);

  act(() => { vi.advanceTimersByTime(4500); });
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED, 'given up for dead');
  assert.equal(lastStatus(), 'connecting');

  act(() => socket(2).serverOpens());
  assert.equal(lastStatus(), 'connected');
  assert.deepEqual(events, ['websocket_reconnected']);
});

test('a quick app switch keeps the open socket', () => {
  renderProvider();
  act(() => socket(0).serverOpens());

  act(() => setPageHidden(true));
  act(() => { vi.advanceTimersByTime(5000); });
  act(() => setPageHidden(false));

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(lastStatus(), 'connected');
});

test('a socket that died in the background reconnects as soon as the page is back', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => setPageHidden(true));
  act(() => socket(0).serverDrops());
  // A suspended page runs no timers, so the scheduled retry never fired.
  act(() => setPageHidden(false));

  assert.equal(FakeWebSocket.instances.length, 2, 'reconnected without waiting for the retry timer');
  assert.equal(lastStatus(), 'connecting');
  act(() => { vi.advanceTimersByTime(3000); });
  assert.equal(FakeWebSocket.instances.length, 2, 'the pending retry was cancelled');
});

test('an online event with no offline before it checks the socket', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => { vi.advanceTimersByTime(60_000); });
  act(() => { window.dispatchEvent(new Event('online')); });

  assert.deepEqual(socket(0).sent, [{ type: 'chat.ping' }]);
  assert.equal(FakeWebSocket.instances.length, 2);
  act(() => socket(1).serverOpens());
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED);
  assert.equal(lastStatus(), 'connected');
});

test('a late online event keeps a socket that just opened on the new network', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => { vi.advanceTimersByTime(500); });
  act(() => { window.dispatchEvent(new Event('online')); });

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(socket(0).readyState, FakeWebSocket.OPEN);
});

test('going offline after a socket opened makes the next online replace it', () => {
  renderProvider();
  act(() => socket(0).serverOpens());
  act(() => { vi.advanceTimersByTime(500); });
  act(() => { window.dispatchEvent(new Event('offline')); });
  act(() => { vi.advanceTimersByTime(500); });
  act(() => { window.dispatchEvent(new Event('online')); });

  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(socket(0).readyState, FakeWebSocket.CLOSED);
});

test('failed handshakes are retried sooner at first, backing off to three seconds', () => {
  renderProvider();
  const retryAfter = (ms: number) => {
    const count = FakeWebSocket.instances.length;
    act(() => socket(count - 1).serverDrops());
    act(() => { vi.advanceTimersByTime(ms - 1); });
    assert.equal(FakeWebSocket.instances.length, count, `no retry before ${ms} ms`);
    act(() => { vi.advanceTimersByTime(1); });
    assert.equal(FakeWebSocket.instances.length, count + 1, `retried after ${ms} ms`);
  };

  retryAfter(500);
  retryAfter(1000);
  retryAfter(2000);
  retryAfter(3000);
  retryAfter(3000);

  // An open resets the backoff.
  const count = FakeWebSocket.instances.length;
  act(() => socket(count - 1).serverOpens());
  act(() => socket(count - 1).serverDrops());
  act(() => { vi.advanceTimersByTime(500); });
  retryAfter(500);
});
