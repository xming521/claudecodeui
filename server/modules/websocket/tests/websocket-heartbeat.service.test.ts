import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WebSocket } from 'ws';

import { attachWebSocketHeartbeat } from '@/modules/websocket/services/websocket-server.service.js';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    pingCount: number;
    terminateCount: number;
    ping: () => void;
    terminate: () => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.pingCount = 0;
  socket.terminateCount = 0;
  socket.ping = () => {
    socket.pingCount += 1;
  };
  socket.terminate = () => {
    socket.terminateCount += 1;
  };
  return socket;
}

function createScheduler() {
  let callback: (() => void) | null = null;
  let wasCleared = false;

  return {
    setInterval(nextCallback: () => void) {
      callback = nextCallback;
      return 1 as unknown as NodeJS.Timeout;
    },
    clearInterval() {
      wasCleared = true;
    },
    tick() {
      callback?.();
    },
    cleared() {
      return wasCleared;
    },
  };
}

test('heartbeat terminates an open socket after twenty unanswered pings', () => {
  const socket = createFakeSocket();
  const scheduler = createScheduler();
  attachWebSocketHeartbeat(socket as never, 30_000, scheduler);

  for (let tick = 0; tick < 20; tick += 1) {
    scheduler.tick();
  }
  assert.equal(socket.pingCount, 20);
  assert.equal(socket.terminateCount, 0, 'a suspended page gets ten minutes');

  scheduler.tick();
  assert.equal(socket.terminateCount, 1);
  assert.equal(scheduler.cleared(), true);
});

test('heartbeat forgives missed pings once the socket answers again', () => {
  const socket = createFakeSocket();
  const scheduler = createScheduler();
  attachWebSocketHeartbeat(socket as never, 30_000, scheduler);

  // The page was hidden for nine and a half minutes, then came back.
  for (let tick = 0; tick < 19; tick += 1) {
    scheduler.tick();
  }
  socket.emit('pong');
  for (let tick = 0; tick < 19; tick += 1) {
    scheduler.tick();
  }

  assert.equal(socket.terminateCount, 0);
});

test('heartbeat keeps responsive sockets open and stops after close', () => {
  const socket = createFakeSocket();
  const scheduler = createScheduler();
  attachWebSocketHeartbeat(socket as never, 30_000, scheduler);

  scheduler.tick();
  socket.emit('pong');
  scheduler.tick();

  assert.equal(socket.pingCount, 2);
  assert.equal(socket.terminateCount, 0);

  socket.emit('close');
  assert.equal(scheduler.cleared(), true);
});
