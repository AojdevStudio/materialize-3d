import { invoke } from '@tauri-apps/api/core'

/** The paired computer as Rust shows it to the window. The device token stays in Rust. */
export interface Computer {
  name: string
  origin: string
}

export const pairing = {
  current: () => invoke<Computer | null>('paired_computer'),
  pair: (link: string, device: string) => invoke<Computer>('pair', { link, device }),
  forget: () => invoke<void>('forget'),
}

/**
 * The paired computer's service, through Rust's `m3dremote://` protocol (`src-mobile/src/remote.rs`). Rust adds the
 * device token. iOS serves a custom scheme on `localhost`.
 */
export const remoteUrl = (path: string) => `m3dremote://localhost${path}`

export async function remoteJson<T>(path: string): Promise<T> {
  const response = await fetch(remoteUrl(path))
  if (!response.ok) throw new Error((await response.text()) || `The computer answered ${response.status}.`)
  return (await response.json()) as T
}
