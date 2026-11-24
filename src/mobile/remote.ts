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

/** Stops the model download a chat left behind, in Rust, where the download runs. */
export const stopModelReads = () => invoke<void>('stop_model_reads')

/**
 * The paired computer's service, through Rust's `m3dremote://` protocol (`src-mobile/src/remote.rs`). Rust adds the
 * device token. iOS serves a custom scheme on `localhost`.
 */
/**
 * The largest answer Rust's `m3dremote://` protocol holds, `ANSWER_LIMIT` in `src-mobile/src/remote.rs`. A model file the
 * list says is larger is not fetched at all. A test holds the two equal.
 */
export const PREVIEW_LIMIT = 64 * 1024 * 1024

export const remoteUrl = (path: string) => `m3dremote://localhost${path}`

export async function remoteJson<T>(path: string): Promise<T> {
  const response = await fetch(remoteUrl(path))
  if (!response.ok) throw new Error((await response.text()) || `The computer answered ${response.status}.`)
  return (await response.json()) as T
}
