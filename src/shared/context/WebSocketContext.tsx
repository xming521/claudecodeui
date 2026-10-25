import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAuth } from '@/modules/auth';
import { IS_PLATFORM } from '@/shared/utils';
import { expireAuthSession, isAuthTokenExpired } from '@/shared/authToken';
import type { ServerEvent } from '@/shared/types';


type ServerEventListener = (event: ServerEvent) => void;

/**
 * Where the chat socket stands. `connecting` covers a handshake the provider
 * started on purpose (after sign-in, or on returning to a page whose socket
 * went stale) and the time signed out; `disconnected` a
 * socket that closed on its own (it dropped, or an attempt failed) until a
 * reconnect opens again.
 */
type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

type WebSocketContextType = {
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  /**
   * Subscribes to every websocket frame. Returns an unsubscribe function.
   *
   * This is the primary consumption API: events are dispatched synchronously
   * to every listener, so rapid back-to-back frames cannot be coalesced or
   * dropped. Frames are deliberately not copied into React state; each
   * listener updates only the state owned by the feature that handles it.
   */
  subscribe: (listener: ServerEventListener) => () => void;
  isConnected: boolean;
  /**
   * Lets the UI tell a lost connection (`disconnected`, reconnecting every few
   * seconds) apart from the first handshake (`connecting`), so it can show the
   * former without flashing on every page load. A socket the provider replaces
   * on purpose, such as on returning to a stale page, reports `connecting`
   * until the new one opens, never `disconnected`.
   */
  connectionStatus: ConnectionStatus;
};

const WebSocketContext = createContext<WebSocketContextType | null>(null);

/** First retry after an open socket drops: most drops are a blip. */
const QUICK_RECONNECT_DELAY_MS = 500;
/**
 * Longest wait between failed handshakes. Retries start at the quick delay
 * and double up to this: right after a phone unlocks, the first handshake
 * often fails because the network is still waking, and is fine a moment later.
 */
const RECONNECT_DELAY_MS = 3000;
/**
 * An `online` event this soon after a socket opened, with no `offline` since,
 * describes the network that socket already opened on. A phone delivers it
 * late on resume, and replacing the new socket would redo the handshake.
 */
const ONLINE_GRACE_AFTER_OPEN_MS = 10_000;
/**
 * A page hidden this long gets a fresh socket when it comes back, even if the
 * old one still reads as open. Phones suspend hidden pages, so the page stops
 * answering the server's 30 s pings and the server drops it within a minute,
 * usually without the page hearing about it until well after it is back.
 */
const STALE_AFTER_HIDDEN_MS = 20_000;

/** Closes a socket without letting its handlers report a drop or schedule a reconnect. */
function discardSocket(socket: WebSocket) {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  socket.close();
}

export const useWebSocket = () => {
  const context = useContext(WebSocketContext);
  if (!context) {
    throw new Error('useWebSocket must be used within a WebSocketProvider');
  }
  return context;
};

const buildWebSocketUrl = (token: string | null) => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/ws`; // Platform mode: Use same domain as the page (goes through proxy)
  if (!token) return null;
  if (isAuthTokenExpired(token)) {
    expireAuthSession(token);
    return null;
  }
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`; // OSS mode: Use same host:port that served the page
};

const useWebSocketProviderState = (): WebSocketContextType => {
  const wsRef = useRef<WebSocket | null>(null);
  const unmountedRef = useRef(false); // Track if component is unmounted
  const hasConnectedRef = useRef(false); // Track if we've ever connected (to detect reconnects)
  /**
   * Listener registry for the subscribe API. A ref (not state) because the
   * set must be readable synchronously inside `onmessage` and never trigger
   * re-renders of the provider tree.
   */
  const listenersRef = useRef(new Set<ServerEventListener>());
  // Drives `isConnected` and the workspace header's "Reconnecting" indicator.
  // Three values rather than a boolean: a first handshake still in flight must
  // not read as a lost connection, or every page load would flash the indicator.
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  /** Failed handshakes since the last open, for the retry backoff. */
  const failedAttemptsRef = useRef(0);
  /** When the current socket opened, or null while none is open. */
  const openedAtRef = useRef<number | null>(null);
  const { isLoading: isAuthLoading, token, user } = useAuth();
  // Read at handshake time only. The server checks the token when a socket
  // opens, so a rotated token is for the next socket; replacing an open one
  // on every rotation cut the stream and redid the catch-up for nothing.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const dispatch = useCallback((event: ServerEvent) => {
    for (const listener of listenersRef.current) {
      try {
        listener(event);
      } catch (error) {
        console.error('WebSocket listener error:', error);
      }
    }
  }, []);

  // Named function expression so the reconnect timer below can call itself
  // without reading the `connect` binding while it is still initializing.
  const connect = useCallback(function connect() {
    if (unmountedRef.current) return; // Prevent connection if unmounted
    if (!IS_PLATFORM && (isAuthLoading || !user)) return;
    try {
      // Construct WebSocket URL
      const wsUrl = buildWebSocketUrl(tokenRef.current);

      if (!wsUrl) return console.warn('No authentication token found for WebSocket connection');

      const websocket = new WebSocket(wsUrl);
      // Store connecting sockets too, so a sign-out can close them before
      // their handshake completes.
      wsRef.current = websocket;
      let wasOpen = false;

      websocket.onopen = () => {
        wasOpen = true;
        failedAttemptsRef.current = 0;
        openedAtRef.current = Date.now();
        setConnectionStatus('connected');
        if (hasConnectedRef.current) {
          // This is a reconnect — signal so components can catch up on missed messages
          dispatch({ kind: 'websocket_reconnected', timestamp: Date.now() });
        }
        hasConnectedRef.current = true;
      };

      websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as ServerEvent;
          dispatch(data);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      websocket.onclose = () => {
        if (wsRef.current !== websocket) {
          return;
        }
        // Also reached when the very first attempt fails, which is a lost
        // connection too. The effect cleanup detaches this handler before
        // closing a socket on purpose, so a sign-out never gets here.
        setConnectionStatus('disconnected');
        wsRef.current = null;
        openedAtRef.current = null;

        let delay = QUICK_RECONNECT_DELAY_MS;
        if (!wasOpen) {
          delay = Math.min(RECONNECT_DELAY_MS, QUICK_RECONNECT_DELAY_MS * 2 ** failedAttemptsRef.current);
          failedAttemptsRef.current += 1;
        }
        reconnectTimeoutRef.current = setTimeout(() => {
          if (unmountedRef.current) return; // Prevent reconnection if unmounted
          connect();
        }, delay);
      };

      websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

    } catch (error) {
      console.error('Error creating WebSocket connection:', error);
    }
  }, [dispatch, isAuthLoading, user]); // reconnect when sign-in state changes, not on token rotation

  // Declared after `connect` so the effect body does not reference it before
  // initialization. `connect` is memoized on [dispatch, isAuthLoading, user]
  // and `dispatch` is stable, so depending on it reconnects on exactly the
  // same transitions as the [isAuthLoading, user] list.
  useEffect(() => {
    // The cleanup below sets unmountedRef = true. Without this reset, every
    // re-run of the effect (e.g. on signing in again) would short-circuit connect()
    // at its unmounted guard and leave the socket permanently disconnected.
    unmountedRef.current = false;
    if (!IS_PLATFORM && (isAuthLoading || !user)) {
      return undefined;
    }
    connect();

    // Replaces the socket now rather than waiting for the browser to report
    // the old one dead, which on a phone can take a minute after unlocking.
    const reconnectNow = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        discardSocket(wsRef.current);
        wsRef.current = null;
      }
      openedAtRef.current = null;
      // Started on purpose, so a quick reopen shows no warning; a failure
      // still reads as disconnected.
      setConnectionStatus('connecting');
      connect();
    };

    let hiddenAt: number | null = document.hidden ? Date.now() : null;
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      const socket = wsRef.current;
      const isClosed = !socket
        || socket.readyState === WebSocket.CLOSING
        || socket.readyState === WebSocket.CLOSED;
      if (isClosed || hiddenFor >= STALE_AFTER_HIDDEN_MS) {
        reconnectNow();
      }
    };
    // Whatever socket existed before the network went away is dead. One that
    // opened after the last `offline` and only just now is on the new network.
    let offlineAt: number | null = null;
    const handleOffline = () => {
      offlineAt = Date.now();
    };
    const handleOnline = () => {
      const openedAt = openedAtRef.current;
      const openedJustNow = openedAt !== null
        && Date.now() - openedAt < ONLINE_GRACE_AFTER_OPEN_MS
        && (offlineAt === null || openedAt > offlineAt);
      if (openedJustNow && wsRef.current?.readyState === WebSocket.OPEN) {
        return;
      }
      reconnectNow();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      unmountedRef.current = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      const activeSocket = wsRef.current;
      if (activeSocket) {
        // Prevent the intentionally closed socket from scheduling a
        // reconnect after the next run of this effect has already started.
        discardSocket(activeSocket);
        wsRef.current = null;
      }
      openedAtRef.current = null;
      // What comes next is a socket after a fresh sign-in, or none after a
      // sign-out or session expiry. Either way it starts from a fresh
      // handshake: the socket closed here is no longer live, and a drop seen
      // before must not show as "Reconnecting" after the next sign-in.
      setConnectionStatus('connecting');
    };
  }, [connect, isAuthLoading, user]); // reconnect after sign-in or sign-out

  const sendMessage = useCallback((message: unknown) => {
    const socket = wsRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected');
    }
  }, []);

  const subscribe = useCallback((listener: ServerEventListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  const value: WebSocketContextType = useMemo(() =>
  ({
    ws: wsRef.current,
    sendMessage,
    subscribe,
    isConnected: connectionStatus === 'connected',
    connectionStatus,
  }), [sendMessage, subscribe, connectionStatus]);

  return value;
};

/** Mounted once by App; owns the single chat websocket that the chat, project-workspace and task-master modules subscribe to. */
export const WebSocketProvider = ({ children }: { children: React.ReactNode }) => {
  const webSocketData = useWebSocketProviderState();

  return (
    <WebSocketContext.Provider value={webSocketData}>
      {children}
    </WebSocketContext.Provider>
  );
};

export default WebSocketContext;
