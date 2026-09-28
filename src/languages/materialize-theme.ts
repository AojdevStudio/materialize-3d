/**
 * Custom Monaco dark theme matching Materialize 3D's design tokens.
 *
 * Based on `vs-dark` with colors pulled from tokens.css.
 */
import type * as monaco from 'monaco-editor'

export const MATERIALIZE_THEME_ID = 'materialize-dark'

export const materializeDarkTheme: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5a5862', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'a78bfa' },         // accent-purple
    { token: 'constant.language', foreground: 'e8682a' }, // accent-orange
    { token: 'variable.predefined', foreground: '60a5fa' }, // accent-blue
    { token: 'number', foreground: '34d399' },            // accent-green
    { token: 'number.float', foreground: '34d399' },
    { token: 'string', foreground: 'fbbf24' },            // accent-yellow
    { token: 'string.escape', foreground: 'e8682a' },
    { token: 'operator', foreground: 'e8e6e3' },          // text-primary
    { token: 'delimiter', foreground: '8a8891' },          // text-secondary
    { token: 'identifier', foreground: 'e8e6e3' },
  ],
  colors: {
    'editor.background': '#111114',                        // bg-surface
    'editor.foreground': '#e8e6e3',                        // text-primary
    'editor.lineHighlightBackground': '#18181c',           // bg-elevated
    'editor.selectionBackground': '#e8682a33',             // accent-orange-dim
    'editorCursor.foreground': '#e8682a',                  // accent-orange
    'editorLineNumber.foreground': '#5a5862',              // text-tertiary
    'editorLineNumber.activeForeground': '#8a8891',        // text-secondary
    'editorIndentGuide.background': '#1e1e23',             // border-subtle
    'editorIndentGuide.activeBackground': '#2a2a30',       // border
    'editor.selectionHighlightBackground': '#60a5fa22',    // accent-blue-dim
    'editorBracketMatch.background': '#e8682a33',
    'editorBracketMatch.border': '#e8682a',
    'editorGutter.background': '#0a0a0c',                  // bg-deep
    'editorWidget.background': '#18181c',
    'editorWidget.border': '#2a2a30',
    'editorError.foreground': '#f87171',                   // accent-red
    'editorWarning.foreground': '#fbbf24',                 // accent-yellow
  },
}

/**
 * Define the Materialize dark theme in Monaco.
 * Safe to call multiple times.
 */
export function definematerializeTheme(monacoInstance: typeof import('monaco-editor')) {
  monacoInstance.editor.defineTheme(MATERIALIZE_THEME_ID, materializeDarkTheme)
}
