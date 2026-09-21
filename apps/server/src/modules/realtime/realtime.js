const { WebSocket, WebSocketServer } = require('ws');

const realtimeProtocol = 'deliveryflow.realtime.v1';
const authenticationProtocolPrefix = 'auth.';
const accessTokenPattern = /^[A-Za-z0-9_-]{43}$/;

function parseProtocols(header = '') {
  return header.split(',').map((protocol) => protocol.trim()).filter(Boolean);
}

function rejectUpgrade(socket, statusCode, statusText) {
  socket.end([
    `HTTP/1.1 ${statusCode} ${statusText}`,
    'Connection: close',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n'));
}

function createRealtimeHub(server, authenticateAccessToken) {
  const clientsByDriverId = new Map();
  let sequence = 0;
  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    maxPayload: 1024,
    handleProtocols(protocols) {
      return protocols.has(realtimeProtocol) ? realtimeProtocol : false;
    },
  });

  function registerClient(driverId, socket) {
    const clients = clientsByDriverId.get(driverId) || new Set();
    clients.add(socket);
    clientsByDriverId.set(driverId, clients);
    socket.driverId = driverId;
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('close', () => {
      clients.delete(socket);
      if (!clients.size) clientsByDriverId.delete(driverId);
    });
  }

  function send(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(payload);
    } catch {
      socket.terminate();
    }
  }

  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname !== '/api/realtime') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const protocols = parseProtocols(request.headers['sec-websocket-protocol']);
    const authenticationProtocol = protocols.find((protocol) => protocol.startsWith(authenticationProtocolPrefix));
    const accessToken = authenticationProtocol?.slice(authenticationProtocolPrefix.length);
    if (!protocols.includes(realtimeProtocol) || !accessTokenPattern.test(accessToken || '')) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    try {
      const driver = await authenticateAccessToken(accessToken);
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        registerClient(driver.id, webSocket);
        webSocketServer.emit('connection', webSocket, request);
      });
    } catch {
      rejectUpgrade(socket, 401, 'Unauthorized');
    }
  });

  webSocketServer.on('connection', (socket) => {
    send(socket, JSON.stringify({
      type: 'realtime.connected',
      sequence,
      occurredAt: new Date().toISOString(),
    }));
  });

  const heartbeat = setInterval(() => {
    for (const clients of clientsByDriverId.values()) {
      for (const socket of clients) {
        if (!socket.isAlive) {
          socket.terminate();
          continue;
        }
        socket.isAlive = false;
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }
    }
  }, 30_000);
  heartbeat.unref();

  server.on('close', () => clearInterval(heartbeat));

  return {
    publish(reason = 'state.changed') {
      sequence += 1;
      const payload = JSON.stringify({
        type: 'state.changed',
        reason,
        sequence,
        occurredAt: new Date().toISOString(),
      });
      for (const clients of clientsByDriverId.values()) {
        for (const socket of clients) {
          send(socket, payload);
        }
      }
    },
    disconnectDriver(driverId) {
      for (const socket of clientsByDriverId.get(driverId) || []) {
        socket.close(1008, 'Session ended');
      }
    },
  };
}

module.exports = {
  createRealtimeHub,
  realtimeProtocol,
};
