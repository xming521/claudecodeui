import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';

/**
 * A page back from the background sends `chat.ping` on its old socket. The
 * answer proves the socket survived, so the page keeps it instead of
 * reconnecting.
 */

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

test('chat.ping is answered with chat_pong on the same socket', async (t) => {
  t.mock.method(console, 'log', () => undefined);
  const socket = createFakeSocket();
  handleChatConnection(socket as never, { user: { id: 1 } } as never, {} as never);

  socket.emit('message', JSON.stringify({ type: 'chat.ping' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(socket.frames, [{ kind: 'chat_pong' }]);
  socket.emit('close');
});
