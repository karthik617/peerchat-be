/**
 * PeerChat Backend — Production WebSocket Server
 * ─────────────────────────────────────────────
 * Features:
 *   • Redis pub/sub for horizontal scaling (multiple server instances)
 *   • Redis-backed offline message queue with TTL
 *   • Redis-backed presence tracking with heartbeat expiry
 *   • Rate limiting per connection (in-process)
 *   • Graceful shutdown (SIGTERM / SIGINT)
 *   • Structured JSON logging
 *   • Health + metrics REST endpoints
 *   • Message size limits & input validation
 *   • Duplicate connection handling (new login kicks old socket)
 */

'use strict';
const dotenv                         = require('dotenv')
const express                        = require('express');
const http                           = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { createClient }               = require('redis');
const { v4: uuidv4 }                 = require('uuid');

dotenv.config()

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT:             parseInt(process.env.PORT              || '10000',   10),
  HOST:             process.env.HOST                       || '0.0.0.0',
  REDIS_URL:        process.env.REDIS_URL                  || 'redis://localhost:6379',
  QUEUE_TTL_SEC:    parseInt(process.env.QUEUE_TTL_SEC     || '604800', 10), // 7 days
  PRESENCE_TTL_SEC: parseInt(process.env.PRESENCE_TTL_SEC  || '60',    10),
  RATE_LIMIT:       parseInt(process.env.RATE_LIMIT         || '60',    10), // msgs per window
  RATE_WINDOW_MS:   parseInt(process.env.RATE_WINDOW_MS     || '10000', 10),
  MAX_MSG_BYTES:    parseInt(process.env.MAX_MSG_BYTES       || '65536', 10), // 64 KB WS frame
  MAX_CONTENT_LEN:  parseInt(process.env.MAX_CONTENT_LEN    || '4096',  10), // chat content
  PING_INTERVAL_MS: parseInt(process.env.PING_INTERVAL_MS   || '25000', 10),
  INSTANCE_ID:      process.env.INSTANCE_ID                || uuidv4(),
};

// Redis key schema
const K = {
  queue:    (id) => `pc:queue:${id}`,      // List  — serialised envelopes
  presence: (id) => `pc:presence:${id}`,   // String — instance ID
  lastSeen: (id) => `pc:lastseen:${id}`,   // String — unix ms
  channel:  (id) => `pc:msg:${id}`,        // Pub/sub channel per device
  broadcast:       'pc:broadcast',          // Pub/sub presence broadcast
};

// ─── Logger ───────────────────────────────────────────────────────────────────
const log = {
  info:  (msg, meta = {}) => console.log (JSON.stringify({ level: 'info',  ts: new Date().toISOString(), msg, ...meta })),
  warn:  (msg, meta = {}) => console.warn (JSON.stringify({ level: 'warn',  ts: new Date().toISOString(), msg, ...meta })),
  error: (msg, meta = {}) => console.error(JSON.stringify({ level: 'error', ts: new Date().toISOString(), msg, ...meta })),
};

// ─── Redis clients ────────────────────────────────────────────────────────────
// Three separate clients required: commands, publisher, subscriber
const redis    = createClient({ url: CONFIG.REDIS_URL });
const redisPub = createClient({ url: CONFIG.REDIS_URL });
const redisSub = createClient({ url: CONFIG.REDIS_URL });

redis.on   ('error', e => log.error('Redis cmd error', { error: e.message }));
redisPub.on('error', e => log.error('Redis pub error', { error: e.message }));
redisSub.on('error', e => log.error('Redis sub error', { error: e.message }));

// ─── Local socket registry (this instance only) ───────────────────────────────
// Map<deviceId, { ws, pingTimer, rateCount, rateReset, remoteIp }>
const localClients = new Map();

// ─── Metrics ──────────────────────────────────────────────────────────────────
const metrics = {
  connectionsTotal:  0,
  messagesRelayed:   0,
  messagesQueued:    0,
  messagesDelivered: 0,
  errors:            0,
};

// ═════════════════════════════════════════════════════════════════════════════
// REDIS HELPERS
// ═════════════════════════════════════════════════════════════════════════════

async function enqueueMessage(deviceId, envelope) {
  const key = K.queue(deviceId);
  await redis.rPush(key, JSON.stringify(envelope));
  await redis.expire(key, CONFIG.QUEUE_TTL_SEC);
  metrics.messagesQueued++;
  log.info('Message queued', { to: deviceId, id: envelope.id });
}

async function flushQueue(deviceId) {
  const key  = K.queue(deviceId);
  const msgs = await redis.lRange(key, 0, -1);
  if (msgs.length) await redis.del(key);
  return msgs
    .map(m => { try { return JSON.parse(m); } catch { return null; } })
    .filter(Boolean);
}

async function setPresenceOnline(deviceId) {
  await Promise.all([
    redis.set(K.presence(deviceId), CONFIG.INSTANCE_ID, { EX: CONFIG.PRESENCE_TTL_SEC }),
    redis.set(K.lastSeen(deviceId), String(Date.now())),
  ]);
}

async function setPresenceOffline(deviceId) {
  await Promise.all([
    redis.del(K.presence(deviceId)),
    redis.set(K.lastSeen(deviceId), String(Date.now())),
  ]);
}

async function refreshPresence(deviceId) {
  await redis.expire(K.presence(deviceId), CONFIG.PRESENCE_TTL_SEC);
}

async function getLastSeen(deviceId) {
  const v = await redis.get(K.lastSeen(deviceId));
  return v ? parseInt(v, 10) : null;
}

async function isOnline(deviceId) {
  return Boolean(await redis.exists(K.presence(deviceId)));
}

// ═════════════════════════════════════════════════════════════════════════════
// PUB / SUB — cross-instance routing
// ═════════════════════════════════════════════════════════════════════════════

function handlePubSubMessage(raw, channel) {
  try {
    const msg = JSON.parse(raw);

    if (channel === K.broadcast) {
      // Broadcast presence to all local clients
      const out = JSON.stringify(msg);
      localClients.forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(out);
      });
      return;
    }

    // Direct message — find the local client
    const deviceId = channel.slice('pc:msg:'.length);
    const client   = localClients.get(deviceId);
    if (client && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(raw);
      metrics.messagesDelivered++;
    }
  } catch (e) {
    log.error('pub/sub handle error', { error: e.message });
    metrics.errors++;
  }
}

async function deliverOrQueue(envelope) {
  const { to } = envelope;

  // 1. Local delivery (same instance — fastest path)
  const local = localClients.get(to);
  if (local && local.ws.readyState === WebSocket.OPEN) {
    local.ws.send(JSON.stringify({ type: 'new_message', payload: envelope }));
    metrics.messagesRelayed++;
    metrics.messagesDelivered++;
    return;
  }

  // 2. Remote delivery via pub/sub (different instance)
  const instanceId = await redis.get(K.presence(to));
  if (instanceId && instanceId !== CONFIG.INSTANCE_ID) {
    await redisPub.publish(
      K.channel(to),
      JSON.stringify({ type: 'new_message', payload: envelope })
    );
    metrics.messagesRelayed++;
    return;
  }

  // 3. Offline — enqueue
  await enqueueMessage(to, envelope);
}

async function publishPresence(deviceId, online) {
  await redisPub.publish(K.broadcast, JSON.stringify({
    type: 'presence',
    payload: { deviceId, online, timestamp: Date.now() },
  }));
}

// ═════════════════════════════════════════════════════════════════════════════
// RATE LIMITING
// ═════════════════════════════════════════════════════════════════════════════

function checkRateLimit(client) {
  const now = Date.now();
  if (now > client.rateReset) {
    client.rateCount = 0;
    client.rateReset = now + CONFIG.RATE_WINDOW_MS;
  }
  return ++client.rateCount <= CONFIG.RATE_LIMIT;
}

// ═════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CONNECTION HANDLER
// ═════════════════════════════════════════════════════════════════════════════

function handleConnection(ws, req) {
  const remoteIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
                || req.socket.remoteAddress;

  metrics.connectionsTotal++;

  let deviceId   = null;
  const client   = {
    ws,
    pingTimer:  null,
    rateCount:  0,
    rateReset:  Date.now() + CONFIG.RATE_WINDOW_MS,
    remoteIp,
  };

  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function reject(code, reason) {
    log.warn('Connection rejected', { reason, remoteIp });
    ws.close(code, reason);
  }

  // ── Incoming frames ────────────────────────────────────────────────────────
  ws.on('message', async (raw, isBinary) => {
    if (isBinary)              { reject(1003, 'binary not supported'); return; }
    if (raw.length > CONFIG.MAX_MSG_BYTES) { reject(1009, 'message too large'); return; }
    if (!checkRateLimit(client)) {
      send({ type: 'error', code: 'rate_limited' });
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); }
    catch { send({ type: 'error', code: 'invalid_json' }); return; }

    // ── register ─────────────────────────────────────────────────────────────
    if (msg.type === 'register') {
      const id = (msg.deviceId || '').trim();
      if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
        reject(1008, 'invalid deviceId');
        return;
      }

      // Kick duplicate connection on this instance
      const existing = localClients.get(id);
      if (existing) {
        existing.ws.close(4001, 'replaced');
        clearInterval(existing.pingTimer);
        localClients.delete(id);
      }

      deviceId = id;

      // Start WS-level ping (protocol ping, not app-level)
      client.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          refreshPresence(deviceId).catch(() => {});
        }
      }, CONFIG.PING_INTERVAL_MS);

      localClients.set(deviceId, client);
      await redisSub.subscribe(K.channel(deviceId), handlePubSubMessage);
      await setPresenceOnline(deviceId);
      await publishPresence(deviceId, true);

      send({ type: 'registered', deviceId });

      // Deliver offline queue
      const queued = await flushQueue(deviceId);
      for (const envelope of queued) {
        send({ type: 'queued_message', payload: envelope });
        metrics.messagesDelivered++;
      }
      if (queued.length) log.info('Queue flushed', { deviceId, count: queued.length });

      // Online list (local instance — sufficient for small-medium deploys)
      const onlineNow = [...localClients.keys()].filter(k => k !== deviceId);
      send({ type: 'online_list', payload: onlineNow });

      log.info('Registered', { deviceId, remoteIp });
      return;
    }

    // All other types require registration
    if (!deviceId) { send({ type: 'error', code: 'not_registered' }); return; }

    // ── send_message ──────────────────────────────────────────────────────────
    if (msg.type === 'send_message') {
      const { to, message } = msg;
      if (!to || typeof to !== 'string' || to.length > 128) {
        send({ type: 'error', code: 'invalid_recipient' }); return;
      }
      if (!message || typeof message.content !== 'string' || message.content.length === 0) {
        send({ type: 'error', code: 'invalid_message' }); return;
      }
      if (message.content.length > CONFIG.MAX_CONTENT_LEN) {
        send({ type: 'error', code: 'content_too_long' }); return;
      }

      const envelope = {
        id:        (typeof message.id === 'string' && message.id.length <= 64)
                     ? message.id : uuidv4(),
        from:      deviceId,
        to,
        content:   message.content,
        type:      'text',
        timestamp: (typeof message.timestamp === 'number') ? message.timestamp : Date.now(),
      };

      await deliverOrQueue(envelope);
      send({ type: 'message_ack', messageId: envelope.id });
      return;
    }

    // ── ping (app-level heartbeat) ────────────────────────────────────────────
    if (msg.type === 'ping') {
      await refreshPresence(deviceId);
      send({ type: 'pong', timestamp: Date.now() });
      return;
    }

    send({ type: 'error', code: 'unknown_type' });
  });

  // Protocol-level pong updates presence TTL
  ws.on('pong', () => {
    if (deviceId) refreshPresence(deviceId).catch(() => {});
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  ws.on('close', async (code) => {
    clearInterval(client.pingTimer);
    if (!deviceId) return;

    localClients.delete(deviceId);
    redisSub.unsubscribe(K.channel(deviceId)).catch(() => {});
    await setPresenceOffline(deviceId);
    await publishPresence(deviceId, false);

    log.info('Disconnected', { deviceId, code, remoteIp });
  });

  ws.on('error', (err) => {
    log.error('Socket error', { deviceId, error: err.message });
    metrics.errors++;
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTP SERVER
// ═════════════════════════════════════════════════════════════════════════════

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, maxPayload: CONFIG.MAX_MSG_BYTES });

app.use(express.json({ limit: '16kb' }));
app.disable('x-powered-by');

// Health
app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
    res.json({ status: 'ok', instance: CONFIG.INSTANCE_ID, uptime: process.uptime() });
  } catch {
    res.status(503).json({ status: 'error', error: 'Redis unavailable' });
  }
});

// Metrics
app.get('/metrics', (_req, res) => {
  res.json({
    instance:         CONFIG.INSTANCE_ID,
    localConnections: localClients.size,
    uptime:           process.uptime(),
    memory:           process.memoryUsage(),
    ...metrics,
  });
});

// Presence  GET /presence?ids=a,b,c
app.get('/presence', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
  if (!ids.length) { res.status(400).json({ error: 'No ids' }); return; }
  const result = {};
  await Promise.all(ids.map(async id => {
    const [online, lastSeenTs] = await Promise.all([isOnline(id), getLastSeen(id)]);
    result[id] = { online, lastSeen: lastSeenTs };
  }));
  res.json(result);
});

// Queue depth  GET /queue/:deviceId
app.get('/queue/:deviceId', async (req, res) => {
  const len = await redis.lLen(K.queue(req.params.deviceId));
  res.json({ deviceId: req.params.deviceId, pending: len });
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

wss.on('connection', handleConnection);

// ═════════════════════════════════════════════════════════════════════════════
// STARTUP & GRACEFUL SHUTDOWN
// ═════════════════════════════════════════════════════════════════════════════

async function start() {
  await Promise.all([redis.connect(), redisPub.connect(), redisSub.connect()]);
  await redisSub.subscribe(K.broadcast, handlePubSubMessage);

  server.listen(CONFIG.PORT, CONFIG.HOST, () => {
    log.info('PeerChat server started', {
      instance: CONFIG.INSTANCE_ID,
      port:     CONFIG.PORT,
      host:     CONFIG.HOST,
    });
  });
}

async function shutdown(signal) {
  log.info('Shutting down', { signal });
  wss.close();
  localClients.forEach(({ ws }) => ws.close(1001, 'Server shutting down'));
  await new Promise(r => setTimeout(r, 3000));
  await Promise.allSettled([redis.quit(), redisPub.quit(), redisSub.quit()]);
  server.close(() => { log.info('Closed'); process.exit(0); });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err    => { log.error('Uncaught exception',   { error: err.message, stack: err.stack }); metrics.errors++; });
process.on('unhandledRejection', reason => { log.error('Unhandled rejection',   { reason: String(reason) }); metrics.errors++; });

start().catch(err => { log.error('Startup failed', { error: err.message }); process.exit(1); });
