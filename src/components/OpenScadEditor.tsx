/**
 * OpenSCAD code editor built on Monaco.
 *
 * Features:
 * - OpenSCAD syntax highlighting via Monarch tokenizer
 * - Error markers driven by openscad store's lastError
 * - Cmd+S / Ctrl+S saves and triggers re-render
 * - Custom dark theme matching app design tokens
 * - Offline-safe: workers bundled via Vite (no CDN)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type OnMount, loader } from '@monaco-editor/react'
import type * as monacoTypes from 'monaco-editor'
import { invoke } from '@tauri-apps/api/core'
import { useOpenScadStore } from '../stores/openscadStore'
import { registerOpenScadLanguage, OPENSCAD_LANGUAGE_ID } from '../languages/openscad'
import { definematerializeTheme, MATERIALIZE_THEME_ID } from '../languages/materialize-theme'
import styles from './OpenScadEditor.module.css'

// Tell @monaco-editor/react to use the locally-installed monaco-editor
// instead of fetching from CDN. The workers are already configured in monaco-env.ts.
import * as monaco from 'monaco-editor'
loader.config({ monaco })

export interface OpenScadEditorProps {
  /** Absolute path to the .scad file to edit */
  filePath: string
  /** Called on Cmd+S with the current editor content */
  onSave: (code: string) => void
  /** Called on every content change (for live preview, etc.) */
  onContentChange?: (code: string) => void
}

const MARKER_OWNER = 'openscad'

export default function OpenScadEditor({ filePath, onSave, onContentChange }: OpenScadEditorProps) {
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const editorRef = useRef<monacoTypes.editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof monacoTypes | null>(null)

  // Track the latest callbacks in refs so the Monaco action always sees the current one
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave

  // Load file content on mount or when filePath changes
  useEffect(() => {
    let cancelled = false
    setFileContent(null)
    setLoadError(null)

    invoke<string>('read_text_file', { path: filePath })
      .then((content) => {
        if (!cancelled) setFileContent(content)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(String(err))
      })

    return () => { cancelled = true }
  }, [filePath])

  // Subscribe to error markers from the openscad store
  const lastError = useOpenScadStore((s) => s.lastError)

  useEffect(() => {
    const editor = editorRef.current
    const m = monacoRef.current
    if (!editor || !m) return

    const model = editor.getModel()
    if (!model) return

    if (lastError && lastError.line) {
      m.editor.setModelMarkers(model, MARKER_OWNER, [
        {
          severity: m.MarkerSeverity.Error,
          message: lastError.message,
          startLineNumber: lastError.line,
          startColumn: 1,
          endLineNumber: lastError.line,
          endColumn: model.getLineMaxColumn(lastError.line),
        },
      ])
    } else {
      m.editor.setModelMarkers(model, MARKER_OWNER, [])
    }
  }, [lastError])

  const handleEditorMount: OnMount = useCallback((editor, m) => {
    editorRef.current = editor
    monacoRef.current = m

    // Register OpenSCAD language & theme
    registerOpenScadLanguage(m)
    definematerializeTheme(m)
    m.editor.setTheme(MATERIALIZE_THEME_ID)

    // Set model language to openscad
    const model = editor.getModel()
    if (model) {
      m.editor.setModelLanguage(model, OPENSCAD_LANGUAGE_ID)
    }

    // Cmd+S / Ctrl+S → save action
    editor.addAction({
      id: 'openscad-save',
      label: 'Save OpenSCAD File',
      keybindings: [
        m.KeyMod.CtrlCmd | m.KeyCode.KeyS,
      ],
      run: (ed) => {
        const code = ed.getValue()
        console.debug('openscad-editor:save', filePath)
        onSaveRef.current(code)
      },
    })

    // Focus the editor
    editor.focus()
  }, [filePath])

  const handleContentChange = useCallback((value: string | undefined) => {
    if (value !== undefined && onContentChange) {
      onContentChange(value)
    }
  }, [onContentChange])

  if (loadError) {
    return (
      <div className={styles.editorContainer}>
        <div className={styles.errorBanner}>
          Failed to load file: {loadError}
        </div>
      </div>
    )
  }

  if (fileContent === null) {
    return (
      <div className={styles.loading}>
        Loading…
      </div>
    )
  }

  return (
    <div className={styles.editorContainer}>
      <Editor
        defaultValue={fileContent}
        language={OPENSCAD_LANGUAGE_ID}
        theme={MATERIALIZE_THEME_ID}
        onChange={handleContentChange}
        onMount={handleEditorMount}
        options={{
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
          lineNumbers: 'on',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          tabSize: 2,
          renderLineHighlight: 'line',
          automaticLayout: true,
          bracketPairColorization: { enabled: true },
          padding: { top: 8, bottom: 8 },
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8,
          },
          overviewRulerLanes: 0,
          hideCursorInOverviewRuler: true,
          overviewRulerBorder: false,
        }}
      />
    </div>
  )
}
