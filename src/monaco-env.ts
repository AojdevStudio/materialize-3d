/**
 * Monaco Editor worker environment configuration.
 *
 * Sets up local Vite-bundled workers so Monaco never fetches from CDN.
 * This is critical for Tauri — the app must work offline.
 *
 * Import this file in the app entrypoint (main.tsx) before React mounts.
 */

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'

self.MonacoEnvironment = {
  getWorker(_workerId: string, _label: string) {
    // All languages use the base editor worker.
    // OpenSCAD is a custom Monarch tokenizer — no separate language worker needed.
    return new editorWorker()
  },
}
