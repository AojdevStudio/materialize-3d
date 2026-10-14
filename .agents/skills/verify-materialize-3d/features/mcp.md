# MCP

External agents reach the app through a local MCP server. It is off by default. When the user turns it on in Settings > External agents, the app serves streamable HTTP at `http://127.0.0.1:45373/mcp` on loopback, behind a bearer token. An external agent can build and revise signs, import a part file, read designs, and read printer status. Approval, export, and print stay with the person in the app.

## Sub-features

- `mcp-enable` covers the External agents switch, stored as `mcp.enabled`. The token is 64 hex characters in the keyring, service `com.materialize3d`, entry `mcp:token`. See [settings](./settings.md) for the section's handles.
- `mcp-auth` covers the bearer check. A request without the token gets HTTP 401.
- `mcp-tools` covers `describe_kind`, `build`, `revise`, `import_part`, `get`, `list`, `show`, and `printer_status`. There is no approve, export, or print tool.
- `mcp-import` covers `import_part {path, title, units}`. `path` is absolute, `title` is 1 to 80 characters, and `units` is `"mm"` or `"in"`. It takes 3MF, binary STL, and ASCII STL, and a 3MF must state the same unit. The file is stored read-only at `<app data>/inputs/<sha256>`. The caps are 64 MiB per file, 1 GiB total, and 10,000 files. The same file, title, and units return the same revision.
- `mcp-get` covers `get {revision_id, wait_s}` with `wait_s` from 0 to 900. While approval is pending, it waits until approval, timeout, or cancel. It returns `exports`, each with `format`, `path`, `sha256`, and `exported_at`.

## How to get to it (user POV)

- Open Settings and turn on the External agents switch. The section shows the URL (`mcp-url`), a copy-command button (`mcp-copy-command`), and a rotate-token button (`mcp-rotate-token`).
- Point an MCP client at the URL with the token as a bearer header.
- Imported parts list in the Signs view, see [signs](./signs.md).

## Driving it with wd.ts

Preconditions:

- Onboarding completed per the baseline in README.md.
- The run was started with `m3d.sh up`, which gives the app its own session keyring. Without it, enabling MCP fails with a keyring error for `mcp:token`.
- No other Materialize 3D instance holds port 45373 on the host.

- **Enable (observed 2026-10-05).** Run `$S/wd.ts click "button[aria-label=Settings]"`, `$S/wd.ts click "[data-testid=mcp-enabled]"`, and `$S/wd.ts wait "[data-testid=mcp-url]"`. It reads `http://127.0.0.1:45373/mcp`.
- **Read the token (observed 2026-10-05).** Run `T=$($S/wd.ts eval "return window.__TAURI_INTERNALS__.invoke('mcp_token')" | jq -r .)`. This is inspection, so it fits the eval rule. The token is 64 characters.
- **Call the server (observed 2026-10-05).** Each response body is SSE: a leading empty `data:` event, then `data: {json}`. Parse the line that starts with `data: {`. Keep `mcp-session-id` from `initialize` and send it back as `Mcp-Session-Id`. A tool result is JSON text in `result.content[0].text`. A minimal bun client, run as `bun mcp.ts "$T"`:

  ```ts
  const url = 'http://127.0.0.1:45373/mcp'
  const base = { Authorization: `Bearer ${Bun.argv[2]}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }
  let sid = ''
  async function post(body: object) {
    const r = await fetch(url, { method: 'POST', headers: sid ? { ...base, 'Mcp-Session-Id': sid } : base, body: JSON.stringify(body) })
    sid ||= r.headers.get('mcp-session-id') ?? ''
    const line = (await r.text()).split('\n').find((l) => l.startsWith('data: {'))
    return { status: r.status, msg: line ? JSON.parse(line.slice(6)) : undefined }
  }
  await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '0' } } })
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }) // HTTP 202
  const { msg } = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_part', arguments: { path: '/abs/cube.stl', title: 'Cube', units: 'mm' } } })
  console.log(msg.result.content[0].text)
  ```

- **Handshake (observed 2026-10-05).** `initialize` returns an `mcp-session-id` header. `notifications/initialized` returns HTTP 202. `tools/list` returns the eight tool names. A request without the token returns HTTP 401.
- **Import (observed 2026-10-05).** Write a 20 mm ASCII STL cube to `$R/fixtures/cube.stl` and call `import_part` with its absolute path, `title "Cube"`, and `units "mm"`. The result has `kind imported_part`, `build verified`, 13 of 13 checks, `requested_by external_mcp`, `approval pending`, `size_mm [20,20,20]`, and the views isometric, front, and top. A second identical call returns `reused: true`. The stored file `inputs/<sha256 of the STL>` in the app data dir has mode `-r--------`.
- **Import in the GUI (observed 2026-10-05).** In the Signs view, the imported part lists as a `sign-revision-row`. `sign-detail` shows `part-pending` and the 13 checks, and `$S/wd.ts count "[data-testid=btn-approve]"` prints `0`.
- **Wait on approval (observed 2026-10-05).** Call `get` with the part's `revision_id` and `wait_s 5`. It returns after 5003 ms with `approval pending` and `exports []`. With `wait_s 901`, the result has `isError` and reads "invalid arguments: wait_s must be from 0 to 900, got 901".
- **Exports (observed 2026-10-05).** Call `get` on an approved, exported sign, see [signs](./signs.md). `exports` holds one record with the export path and the package sha256.
- **No approve tool (observed 2026-10-05).** Calling `approve` returns JSON-RPC error -32602 "tool not found".

## Gotchas

- `wd.ts eval` prints JSON, so pipe the token through `jq -r .` to drop the quotes.
- `m3d.sh up` gives each run its own session keyring, but the Linux keyring backend also links entries into the user's persistent keyring, so runs on one host may share the token. This was not tested. `up` isolates the app data, not the port.
- Port 45373 can clash with a real app on the same host.
- The Settings hint still reads "External agents can build and read signs". That text is stale, because `import_part` exists.
- On the Linux app, `describe_kind` lists only `["sign"]`. The agent never offers `part`, see [parts](./parts.md).
