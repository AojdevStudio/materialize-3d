# Materialize 3D — Application Architecture Design

> macOS native app for agentic 3D printing: search, design, slice, print — via GUI or AI agent, fully synced.

## Overview

Materialize 3D is a Tauri-based macOS desktop app that gives users (and an AI agent) full control over the 3D printing pipeline. Users can interact through a traditional GUI or conversational AI — both paths share the same backend, so they stay perfectly synchronized.

The app targets Bambu Lab printers (initially the P2S) and integrates MakerWorld for model discovery, OpenSCAD for parametric design, OrcaSlicer for slicing, and local MQTT / Bambu Cloud API for printer communication.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| App framework | Tauri (Rust + React/TS) | Small binary, native macOS feel, Rust for I/O-heavy backend, TypeScript for UI |
| Agent SDK | Pi SDK (pi-ai, pi-agent-core, pi-web-ui) | Unified multi-provider LLM API, agent runtime with tool calling, web components for chat UI |
| LLM auth | OAuth to OpenAI/Anthropic (user's own accounts) | No API key management for users, clean UX |
| UX model | Dual — agent-first and GUI-first, fully synced | Either path works; agent actions update the GUI, GUI actions update agent context |
| Slicer | OrcaSlicer CLI, logic ported to Rust | One clean binary, no Bun runtime dependency |
| Printer comms | Local MQTT preferred, Bambu Cloud API fallback | Auto-detected at setup, user confirms |
| OpenSCAD | Parametric customization now, generative design later | Near-term: tweak existing .scad parameters. Long-term: agent writes OpenSCAD from scratch |
| State management | Rust holds truth, React (Zustand) mirrors via Tauri events | Single source of truth in the backend, push-based sync to frontend |

## System Architecture

Three layers communicating through Tauri's typed IPC:

```
┌─────────────────────────────────────────────────────┐
│                   Tauri Window                       │
│                                                      │
│  ┌──────────────────────────────────────────────┐   │
│  │           React Frontend (TypeScript)         │   │
│  │                                               │   │
│  │  ┌─────────┐ ┌──────────┐ ┌──────────────┐  │   │
│  │  │ Chat    │ │ Browser  │ │ Workspace    │  │   │
│  │  │ Panel   │ │ Panel    │ │ (3D preview, │  │   │
│  │  │ (pi-    │ │ (Maker-  │ │  slicer,     │  │   │
│  │  │ web-ui) │ │ World)   │ │  settings)   │  │   │
│  │  └─────────┘ └──────────┘ └──────────────┘  │   │
│  │                                               │   │
│  │  ┌──────────────────────────────────────────┐│   │
│  │  │     Pi SDK Agent Runtime (pi-agent-core) ││   │
│  │  │     Tools → call Tauri commands           ││   │
│  │  └──────────────────────────────────────────┘│   │
│  └──────────────────────────────────────────────┘   │
│                        │ Tauri IPC                    │
│  ┌──────────────────────────────────────────────┐   │
│  │           Rust Backend (src-tauri/)            │   │
│  │                                               │   │
│  │  ┌─────────┐ ┌─────────┐ ┌──────────────┐  │   │
│  │  │ Printer │ │ Slicer  │ │ OpenSCAD     │  │   │
│  │  │ Service │ │ Service │ │ Service      │  │   │
│  │  │ (MQTT + │ │ (Orca-  │ │ (subprocess) │  │   │
│  │  │ Cloud)  │ │ Slicer) │ │              │  │   │
│  │  └─────────┘ └─────────┘ └──────────────┘  │   │
│  │  ┌─────────┐ ┌─────────────────────────────┐│   │
│  │  │ File    │ │ Auth (OAuth tokens,         ││   │
│  │  │ Manager │ │  Bambu credentials)         ││   │
│  │  └─────────┘ └─────────────────────────────┘│   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

Every action — whether triggered by the agent or by the user clicking a button — goes through the same Rust command. `slice_model`, `search_makerworld`, `send_to_printer` — one implementation, two callers.

## Rust Backend — Service Layer

Five services in `src-tauri/`, each exposed as Tauri commands.

### Printer Service

Handles two communication paths:

- **Local MQTT** — Persistent connection to the printer. Subscribes to status topics (temperature, progress, errors, AMS filament state). Publishes control commands (start, pause, resume, stop). Low latency, works without internet.
- **Bambu Cloud API** — REST client using Bambu credentials. Handles device discovery, firmware info, camera feed URL, and anything MQTT can't do. Full fallback if Developer Mode is off.
- **Auto-detection** — On first launch (and in settings), the app probes the printer's MQTT broker. If reachable, recommends local mode. If not, falls back to Cloud. User confirms during setup.

Commands: `get_printer_status`, `get_ams_state`, `start_print`, `pause_print`, `resume_print`, `stop_print`, `get_camera_feed`, `discover_printers`.

### Slicer Service

OrcaSlicer CLI wrapper ported from the existing TypeScript `bambu-slicer` package to Rust:

- Takes STL/3MF path + profile settings, produces sliced 3MF
- Profile resolution (quality, filament, nozzle) with auto-patching of BambuStudio profiles for OrcaSlicer compatibility
- Multi-plate arrangement support

Commands: `slice_model`, `list_profiles`, `preview_slice`.

### OpenSCAD Service

Subprocess management for OpenSCAD CLI:

- **Render** — Takes `.scad` file + parameters, produces STL + preview image
- **Parameter extraction** — Parses customizer parameters from `.scad` files so the UI can show sliders/inputs
- **Live preview** — Watches `.scad` file for changes, re-renders on save

Commands: `render_scad`, `get_scad_parameters`, `set_scad_parameters`, `watch_scad`.

### File Manager

Central model/project storage:

- Downloads models from MakerWorld to a local library
- Manages a project workspace: models, sliced output, OpenSCAD sources
- Tracks model metadata (source URL, license, parameters used)

Commands: `download_model`, `list_library`, `get_model_info`, `import_file`.

### Auth Service

All credential management:

- **OAuth tokens** for OpenAI/Anthropic — stored in macOS Keychain via Tauri's secure storage. Handles token refresh.
- **Bambu Cloud credentials** — reads from `~/.bambu-mcp/credentials.json`, can also store in Keychain.
- **MakerWorld session** — manages cookies/tokens if login is needed for downloads.

Commands: `login_openai`, `login_anthropic`, `login_bambu`, `get_auth_status`, `logout`.

## Frontend — UI Layout

Panel-based layout built in React. See `docs/wireframes/app-layout.html` for the interactive wireframe.

```
┌──────────────────────────────────────────────────────┐
│  Toolbar  [Printer: P2S ●] [AMS: PLA/PETG/—/—] [⚙]│
├────────────┬─────────────────────────┬───────────────┤
│            │                         │               │
│  Sidebar   │     Main Panel          │  Chat Panel   │
│            │     (switchable)        │  (pi-web-ui)  │
│  • Library │                         │               │
│  • Browser │  Active view:           │  Agent chat   │
│  • Design  │  - 3D Preview           │  with tool    │
│  • Print   │  - MakerWorld           │  results      │
│  Queue     │  - OpenSCAD             │  inline       │
│            │  - Print Monitor        │               │
│            │                         │               │
├────────────┴─────────────────────────┴───────────────┤
│  Status Bar  [Printing: 47% ████░░░ ETA 1h23m]      │
└──────────────────────────────────────────────────────┘
```

### Components

**Toolbar** — App logo, printer badge with connection type (MQTT/Cloud), AMS filament slot indicators with colors, settings.

**Sidebar** — Icon navigation: Library, MakerWorld, Design (OpenSCAD), Print Monitor, Print Queue.

**Context Panel** — Secondary sidebar that shows contextual content for the active sidebar item (model library list, OpenSCAD project files, print queue).

**Main Panel** — Tabbed views:
- **3D Preview** — Three.js STL/3MF viewer on a virtual build plate matching P2S dimensions (256x256x256mm). Shows slice layers when loaded.
- **MakerWorld Browser** — Embedded Tauri webview at makerworld.com. Content script detects model pages and extracts metadata for agent context.
- **OpenSCAD Editor** — Code editor (Monaco) + live 3D preview + parameter panel with sliders/inputs from customizer variables.
- **Print Monitor** — Live temperatures, progress, camera feed, AMS state, print history.

**Chat Panel** — Powered by `pi-web-ui` components. Always visible (collapsible). Agent tool results render inline as rich cards (search result grids, model previews, print progress). Provider badge shows active LLM (Claude/GPT).

**Status Bar** — Active print progress, ETA, nozzle temp, connection status (MQTT/Cloud + IP).

## Agent Orchestrator — Pi SDK

### Tool Registry

Tools registered with `pi-agent-core`, each a thin TypeScript function calling a Tauri command:

**Discovery & Browsing**
- `search_makerworld(query, filters?)` — Search models, return thumbnails + metadata
- `get_model_details(model_id)` — Full model info, files, ratings
- `download_model(model_id)` — Download to local library

**Design**
- `create_scad(description)` — Generate OpenSCAD code from natural language
- `modify_scad(file, changes)` — Edit existing `.scad` file
- `set_parameters(file, params)` — Adjust customizer parameters
- `render_preview(file)` — Render STL + preview image

**Slicing**
- `slice_model(path, profile?)` — Slice with auto-detected or specified settings
- `list_profiles()` — Available quality/filament combinations
- `estimate_print(sliced_path)` — Time, filament usage, cost estimate

**Printer Control**
- `get_printer_status()` — Temperatures, state, current job, AMS
- `start_print(sliced_path)` — Send to printer and start
- `pause_print()` / `resume_print()` / `stop_print()`
- `get_camera_snapshot()` — Capture current frame

**UI Control** (agent-GUI sync)
- `show_model(path)` — Open model in 3D preview
- `open_makerworld(url)` — Navigate embedded browser
- `show_notification(message, type)` — Toast notifications
- `navigate_to(view)` — Switch main panel view

### Provider Management

Users link OpenAI and/or Anthropic accounts via OAuth during onboarding. `pi-ai` manages the active provider. Users switch from the chat header dropdown. The agent's system prompt and tools are provider-agnostic.

If a token expires or hits rate limits, the app offers to switch to the other linked provider.

### Dynamic Context Injection

Before each agent turn, the system prompt refreshes with current state:

```
Printer: P2S, connected via MQTT, idle
AMS: [PLA Blue, PETG Orange, PLA White, Empty]
Workspace: Headphone Wall Hook.stl loaded, not sliced
Nozzle: 0.4mm, Bed: 256×256mm
User viewing: 3D Preview panel
```

The agent never needs to ask about printer state or available filaments — it already knows.

## Data Flow & State Synchronization

### Rust Holds Truth

```
Rust Backend State
├── printer_state      (temps, progress, AMS, connection)
├── active_job         (current print)
├── model_library      (models + metadata)
├── workspace          (current model, slice settings, OpenSCAD project)
├── auth_state         (linked providers, token validity)
└── preferences        (default quality, filament, notifications)
```

The frontend subscribes via Tauri events (push-based). When Rust receives an MQTT status update, it emits a `printer:status` event. Both the React UI and agent context see the same update simultaneously.

### Frontend Store

```
Zustand Store
├── printer        ← synced from Rust events
├── workspace      ← synced from Rust events
├── library        ← synced from Rust events
├── ui             ← frontend-only (active panel, sidebar state)
└── chat           ← frontend-only (conversation history, input)
```

Rule: anything the agent can affect lives in Rust state. Anything purely visual lives in frontend-only state.

### Sync Scenarios

**Agent searches, user picks different result:**
1. Agent calls `search_makerworld` → Rust fetches results, emits `workspace:search_results`
2. React renders results in chat and browser panel
3. User clicks a different result → dispatches `select_model` Tauri command
4. Rust updates workspace, emits `workspace:model_changed`
5. 3D preview and agent context both see the new selection

**User browses MakerWorld, agent reacts:**
1. User navigates to a model page in the embedded browser
2. Content script detects model page, emits `browser:model_detected`
3. Rust fetches metadata, updates workspace context
4. Agent's next turn includes: "User is viewing [Model Name] on MakerWorld"

**Print finishes while user is in another view:**
1. MQTT: print complete → Rust emits `printer:job_complete`
2. Toast notification regardless of active view
3. Status bar updates
4. Agent proactively: "Your print just finished — took 52 minutes."

## Printer Communication

### Onboarding Flow

1. **Welcome** — Branding, value prop
2. **Link AI Provider** — OAuth to OpenAI / Anthropic (skippable)
3. **Link Bambu Account** — Sign in with Bambu Cloud, discovers printers
4. **Connection Mode** — Auto-detects MQTT availability. Recommends local if available, falls back to Cloud.
5. **Ready** — Agent greets with printer state and available filaments

### Connection State Machine

```
Disconnected → Discovering → Connected (MQTT | Cloud)
                                  ↓ connection lost
                            Reconnecting
                            tries MQTT → Cloud → Disconnected
```

### Dual-Mode Behavior

| Capability | Local MQTT | Cloud API |
|---|---|---|
| Status updates | Subscription (~100ms) | REST polling (5s) |
| Control commands | MQTT publish | REST API |
| Camera feed | Direct HTTP or Cloud fallback | Cloud URL |
| Device discovery | Bambu Cloud (cached) | Bambu Cloud |
| Firmware info | Bambu Cloud (on-demand) | Bambu Cloud |

### Resilience

- MQTT drops → exponential backoff reconnect
- 3 failed MQTT reconnects → auto-fallback to Cloud API, notify user
- Cloud 401 → prompt re-authentication
- Both fail → offline mode (browse, design, slice — can't print)

## Wireframe

Interactive HTML wireframe at `docs/wireframes/app-layout.html`.

## Open Questions

- **MakerWorld API**: Is there a documented API, or do we need to scrape/reverse-engineer the web interface for search and download?
- **Anthropic OAuth**: OAuth support is newer — may need API key fallback initially.
- **OpenSCAD generation quality**: How well can current LLMs write correct OpenSCAD? May need a validation/fix loop where the agent renders, checks for errors, and iterates.
- **Camera feed latency**: Direct HTTP from printer IP vs Cloud URL — need to test both paths on the P2S.
- **Multi-printer support**: Design supports it (discover_printers returns a list) but initial scope is single printer.
