import { open, save, type OpenDialogOptions, type SaveDialogOptions } from '@tauri-apps/plugin-dialog'

// Native Open/Save panels live outside the webview, so the macOS verification
// harness (src-tauri/src/e2e.rs, `--features e2e` only) answers them by setting
// this global. Only a build with VITE_M3D_E2E=1 reads it; in every other build
// the reader below is constant-folded away and the global is never consulted.
interface ScriptedDialogs {
  nextOpenPath?: string
  nextSavePath?: string
}

declare global {
  interface Window {
    __M3D_E2E_DIALOGS__?: ScriptedDialogs
  }
}

const takeScripted: (key: keyof ScriptedDialogs) => string | undefined =
  import.meta.env.VITE_M3D_E2E === '1'
    ? (key) => {
        const scripted = window.__M3D_E2E_DIALOGS__
        const path = scripted?.[key]
        if (scripted && path !== undefined) delete scripted[key]
        return path
      }
    : () => undefined

/** Picks one file; returns null when the person cancels. */
export async function pickFile(options: OpenDialogOptions): Promise<string | null> {
  const scripted = takeScripted('nextOpenPath')
  if (scripted !== undefined) return scripted
  const picked = await open({ ...options, multiple: false, directory: false })
  return typeof picked === 'string' ? picked : null
}

/** Chooses a save destination; returns null when the person cancels. */
export async function pickSaveTarget(options: SaveDialogOptions): Promise<string | null> {
  return takeScripted('nextSavePath') ?? (await save(options))
}
