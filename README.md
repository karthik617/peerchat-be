# PeerChat — Device-to-Device Messaging

A privacy-first messaging app where users are identified by their device ID
(Base64-encoded hardware hash). No accounts, no phone numbers, no email.

---

## Architecture

```
Device A ──WS──▶ Backend (Node.js) ──WS──▶ Device B
   │                   │
   │         Offline queue (Redis / in-memory)
   │
   └── SQLite (messages + contacts stored on-device)
```

---

## Folder layout

```
peerchat/
├── backend/
│   ├── server.js          WebSocket + offline queue server
│   └── package.json
└── app/
    ├── App.js             Root navigator + WS bootstrap
    ├── utils/
    │   ├── deviceId.js    Stable Base64url device identity
    │   ├── messageStore.js SQLite CRUD (messages + contacts)
    │   └── wsService.js   WebSocket singleton with reconnect + outbound queue
    └── screens/
        ├── ContactListScreen.jsx  Contact list + online dots + unread badges
        ├── ChatScreen.jsx         Conversation + scroll-up pagination
        ├── AddContactScreen.jsx   QR generator + scanner + manual entry
        └── MyProfileScreen.jsx    Own QR code + share / copy
```

---

## Quick start

### 1 — Backend

```bash
cd backend
npm install
node server.js          # or: npm run dev  (nodemon)
# Listening on ws://localhost:3001
```

For production, set the `PORT` environment variable and deploy behind a
reverse proxy (nginx) with TLS (`wss://`).

### 2 — React Native app (Expo)

```bash
cd app
npx expo install \
  @react-navigation/native \
  @react-navigation/stack \
  react-native-screens \
  react-native-safe-area-context \
  @react-native-async-storage/async-storage \
  expo-application \
  expo-device \
  expo-crypto \
  expo-sqlite \
  expo-clipboard \
  expo-sharing \
  expo-barcode-scanner \
  react-native-qrcode-svg \
  eventemitter3 \
  uuid

# Set your server URL in .env (Expo):
# EXPO_PUBLIC_WS_URL=ws://192.168.1.x:3001

npx expo start
```

---

## How the device ID works

1. On first launch, the app reads a platform-native identifier:
   - **iOS**: `getIosIdForVendorAsync()` (stable per app-vendor pair)
   - **Android**: `Application.androidId` (stable per install)
   - **Fallback**: random UUID (simulator / web)
2. The raw value is SHA-256 hashed, truncated to 12 bytes, then Base64url-encoded.
   Result: a 16-character, URL-safe, human-copyable string, e.g. `aB3xK9mPqR7wT2sN`.
3. Stored in AsyncStorage so it survives app restarts.

---

## WebSocket message protocol

| type              | direction         | payload                              |
|-------------------|-------------------|--------------------------------------|
| `register`        | client → server   | `{ deviceId }`                       |
| `registered`      | server → client   | `{ deviceId }`                       |
| `send_message`    | client → server   | `{ to, message: { id, content, … } }`|
| `new_message`     | server → client   | `{ payload: envelope }`              |
| `queued_message`  | server → client   | `{ payload: envelope }`  (on reconnect) |
| `message_ack`     | server → client   | `{ messageId }`                      |
| `presence`        | server → client   | `{ deviceId, online, timestamp }`    |
| `online_list`     | server → client   | `string[]` of online device IDs      |
| `ping` / `pong`   | both              | heartbeat                            |

---

## Offline messaging flow

1. Sender calls `wsService.sendMessage(to, content)`.
2. wsService sends `send_message` to server.
3. **Recipient online** → server relays immediately as `new_message`.
4. **Recipient offline** → server pushes envelope onto `offlineQueue[recipientId]`.
5. When recipient reconnects, server sends all queued messages as `queued_message`
   events during the `register` handshake.

For production, replace the in-memory Map in `server.js` with Redis:
```js
const redis = require('ioredis');
const client = new redis();
// enqueue:  client.rpush(`queue:${recipientId}`, JSON.stringify(msg))
// flush:    client.lrange + client.del
```

---

## Scroll-up message loading

`ChatScreen` uses an **inverted FlatList** (newest messages at the bottom).
When the user scrolls up past 30% of the list, `onEndReached` fires, which
calls `getMessages(myId, peerId, 30, oldestTimestamp)`.  SQLite returns the
next 30 messages ordered by `timestamp DESC` with `timestamp < oldestTimestamp`.
This continues until `hasMore` becomes `false` (fewer than 30 rows returned).

---

## Production checklist

- [ ] Use `wss://` (TLS) — swap `ws://` for `wss://` in `EXPO_PUBLIC_WS_URL`
- [ ] Replace in-memory offline queue with Redis
- [ ] Add push notifications (FCM / APNs) so offline users get a nudge
- [ ] Consider end-to-end encryption (Signal Protocol / libsodium) for message content
- [ ] Rate-limit WebSocket messages per connection on the server
- [ ] Add a contact-map on the server for targeted presence delivery
