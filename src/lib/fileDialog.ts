import { open } from '@tauri-apps/plugin-dialog'

// The native Open panel lives outside the webview, so the macOS verification
// harness (.agents/skills/verify-materialize-3d/scripts/mac.ts) answers it by
// setting this global. Only a build with VITE_M3D_E2E=1 reads it. In every other
// build the reader below is folded away, and CI checks that no build output
// names the global.
interface ScriptedDialogs {
  nextOpenPath?: string
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
export async function pickFile(): Promise<string | null> {
  const scripted = takeScripted('nextOpenPath')
  if (scripted !== undefined) return scripted
  const picked = await open({ multiple: false, directory: false })
  return typeof picked === 'string' ? picked : null
}
