# 1. A paired phone reaches the computer through Tailscale Serve and a loopback service in the sidecar

Status: accepted, 2026-11-24.

## Context

A person's iPhone or iPad must open, read, and send to the chats on their computer, also over cellular. The person already runs the official Tailscale clients on both. The phone must do only what the mobile app needs. Desktop sign-ins and account settings stay on the computer.

## Decision

The Bun sidecar runs a small HTTP service on `127.0.0.1:47380`. It listens on loopback only. Tailscale Serve, which the person sets up in their own Tailscale client, gives the computer a private HTTPS address on the tailnet and forwards it to that port:

```sh
tailscale serve --bg --https=47380 http://127.0.0.1:47380
```

Two ports are in play. The loopback port, `47380` in `http://127.0.0.1:47380`, is fixed. The Serve HTTPS port is the `--https` value, usually also `47380`. One case gets a different one. Serve sends `/` of an address to the service and other paths of it to other services, and no address serves the service alone. Then Settings suggests the first HTTPS port from `47380` to `47479` that Serve does not use, forwarding to the same loopback port. When all of those are in use, Settings says so and suggests none.

Who owns what:

- The person's Tailscale client owns the HTTPS address, its certificate, and who on the tailnet can reach it. Materialize never changes Tailscale settings. It only reads `tailscale serve status --json` to learn the address. It takes only an HTTPS address that sends every path to the service, and refuses one Funnel makes public. A request Tailscale marks as from Funnel answers 403.
- The sidecar owns the loopback listener, the pairing code, and the list of paired devices. The service lives in the sidecar because the sidecar already owns the chats, the drafts, and the project folders. Rust is unchanged.

Each request but the pairing one must carry a device token. A device on the tailnet with no token reads nothing, so Tailscale access alone is not enough.

### Pairing

1. In Settings, the computer shows a QR image. The QR holds one URL: `https://<host>.<tailnet>.ts.net[:<serve port>]/pair?code=<code>`, for example `https://studio.tail0000.ts.net:47380/pair?code=…`. The Serve HTTPS port shows when it is not 443. The app uses the origin exactly as scanned, its port included, and never assumes `47380`. It takes the code from the same URL.
2. The code works once and for 5 minutes. Settings shows it only when Serve gives the service an HTTPS address. A new code replaces the last one. Codes live only in the sidecar's memory, so a restart ends them.
3. The app sends `POST /api/v1/pair` with the code and a device name. The reply holds a device token. The app keeps the origin and the token in the iOS Keychain.
4. The computer keeps only the SHA-256 hash of each token, in its store. A copy of the store cannot act as a device.
5. Forget, in Settings, removes the device. Its token stops working on the next request, and its open event stream ends.

### The API

Every route takes and answers JSON, except where noted. Every request but `pair` needs `Authorization: Bearer <token>`. Without a valid token, every path answers 401, a route or not. With one, a route not in this table answers 404.

| Route | Body | Answer |
|---|---|---|
| `POST /api/v1/pair` | `{ code, name }` | `{ token, device, computer }`. 403 for a code that is wrong, expired, or used. 413 for a body over 4 KB. |
| `GET /api/v1/computer` | | `{ id, name, version, device }` |
| `GET /api/v1/models` | | The models both roles offer, as `models.list` answers the window. |
| `GET /api/v1/chats` | | Each chat with its pair and status, newest activity first. |
| `GET /api/v1/chats/<project>` | | The chat as `chat.open` answers it. Its changes then reach `/events`. |
| `GET /api/v1/events` | | `text/event-stream`. Each `data:` line is one event, as the window gets it: `chat` for a chat's changes, and `project` with the whole project when its roles change on any device. Open it before you read a chat. Forget ends it. |
| `PUT /api/v1/chats/<project>/draft` | `{ text, pictures: [{ name, data }] }` | `{ rev }`. `data` is base64. This device's draft for the chat. |
| `POST /api/v1/chats/<project>/send` | `{ rev }` | `{ project }`. Sending the same `rev` again sends nothing more. A refusal before the send commits answers `{ error }` with the words to show, and `rev` never goes out: `409` when the device saved its draft again after `rev` or settled it, `422` when the chat's lead or helper was retired by its provider, and `423` while the agent still works on the last message. A `422` or `423` also retires `rev`, so a later send of it answers `409`. Any other failure may have come after the commit, so the device settles the send. |
| `POST /api/v1/chats/<project>/sends/<rev>/settle` | | `{ accepted }`, the final word on the send of `rev`. `true` when the chat holds its message. Otherwise the computer takes away the device's draft while it is still `rev`, in the same commit, so a send of `rev` still on its way is refused and the answer stays `false`. A device asks here when a send's answer was lost or could not be read. |
| `PUT /api/v1/chats/<project>/roles` | `{ lead?, helper? }` | `{ lead, helper }`. `helper: null` lets the lead work alone. A refused role saves neither. |
| `GET /api/v1/chats/<project>/files` | | The chat's model files (`.stl`, `.3mf`, `.glb`): `[{ rel, size, modifiedMs }]`, newest first. |
| `GET /api/v1/chats/<project>/files/<rel>` | | The file's bytes, with its model content type. |

The phone calls the service from Rust, not from its web view, so the service sends no CORS headers.

### What the phone cannot do

- Read or change a sign-in, a key, the settings, setup, or the printer. No route names them, and the event stream carries `chat` and `project` events only, since sign-in events hold sign-in links and codes.
- Name a file on the computer. A phone draft takes uploaded pictures only, never a path. A file read stays inside the project folder, takes model files only, skips the app's own records, and follows no link.
- Overwrite the computer's unsent message. Each device keeps its own draft for a chat, apart from the desktop's.

### Who is trusted with the chat folder

The phone is not trusted. It names a chat and a path inside it, and nothing else. The person and their agent are trusted with the chat folder: either can already copy any file into it for the phone to read. So the file rules stop the phone, and they do not try to stop a local writer. Node and Bun have no `openat`, so a walk or a read cannot hold a folder open while it resolves the next name. Each folder is read, and each file opened, only while its real path matches its name, and a read checks the file it opened again after the open. A local writer who swaps a folder twice within that window can still redirect one read. That writer gains nothing it could not get with a copy.

## Consequences

- A person sets up Tailscale Serve once, with the command Settings shows: the one above, or the one with another HTTPS port. Settings shows it until Serve forwards to the service.
- Two apps on one computer cannot both serve phones, since the port is fixed. The second app runs without the service and says why in Settings.
- Any process on the computer can reach the loopback port, but it still needs a token or the code on screen.
- The physical check, an iPhone on cellular with Wi-Fi off, is the owner's. It is not automated here.
