/**
 * The pipe between the Rust core and the sidecar: one JSON object per line, each way.
 *
 * The window calls the sidecar through Rust (`invoke('sidecar')`) and hears it on one event. The sidecar asks
 * Rust for what only Rust can do: the Keychain and the Bambu slice step. This file imports nothing, so the
 * window's code can share its types.
 */

/** What the window can ask the sidecar, by method name. */
export interface Methods {
  'app.ping': { params: Record<string, never>; result: { version: string } }
}

export type Method = keyof Methods

/** What the sidecar can ask Rust. */
export interface HostRequests {
  'keychain.get': { params: { account: string }; result: { secret: string | null } }
  'keychain.set': { params: { account: string; secret: string }; result: null }
  'keychain.delete': { params: { account: string }; result: null }
  slice: { params: SliceParams; result: SliceResult }
}

export type HostRequest = keyof HostRequests

/** Paths are relative to the project folder, which Rust resolves from the project id. */
export interface SliceParams {
  project: string
  inputs: string[]
  output: string
}

export interface SliceResult {
  output: string
  parts: number
  printSeconds: number
  filamentGrams: number
}

/** What the window hears on the one `sidecar://event` channel: the sidecar's own events and, from Rust, the engine's state. */
export type SidecarEvent =
  | { type: 'ready'; version: string }
  | { type: 'engine'; state: 'restarting' | 'stopped'; detail: string }

/** Rust to sidecar. */
export type Inbound =
  | { kind: 'call'; id: number; method: string; params: unknown }
  | { kind: 'answer'; id: number; ok: true; value: unknown }
  | { kind: 'answer'; id: number; ok: false; error: string }

/** Sidecar to Rust. */
export type Outbound =
  | { kind: 'reply'; id: number; ok: true; value: unknown }
  | { kind: 'reply'; id: number; ok: false; error: string }
  | { kind: 'request'; id: number; method: HostRequest; params: unknown }
  | { kind: 'event'; event: SidecarEvent }

/** Exit codes Rust reads. Anything else is a crash, which Rust answers with a restart. */
export const EXIT = {
  /** Stdin closed: the app is quitting. */
  done: 0,
  /** Another process owns the store. Rust must not restart. */
  storeInUse: 75,
} as const
