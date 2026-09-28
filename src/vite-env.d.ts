/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" only in the macOS verification build (mac.ts build); enables scripted file dialogs. */
  readonly VITE_M3D_E2E?: string
}
