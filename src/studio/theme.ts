import { useEffect } from 'react'
import { create } from 'zustand'

export type Theme = 'light' | 'dark'

/**
 * Where the person's choice is kept, in this app's own webview storage, so it outlives a restart. The script in
 * `index.html` reads it before the first paint, and a test holds that script to this key and this parse.
 */
const KEY = 'materialize-3d.theme'

const parse = (saved: string | null): Theme => (saved === 'dark' ? 'dark' : 'light')

/**
 * How a page in a frame learns the theme: a query on its address when it opens, and a message on each change. The guide
 * template (`sidecar/src/templates/guide.html`) listens for both, and a test holds it to these names.
 */
export const FRAME_THEME = { query: 'theme', message: 'm3d:theme' } as const

type ThemeState = { theme: Theme; toggle: () => void }

/**
 * The app's theme. Light unless the person chose dark. Read it with `useTheme((s) => s.theme)`, or follow it outside
 * React with `useTheme.subscribe`.
 */
export const useTheme = create<ThemeState>()((set, get) => ({
  theme: parse(window.localStorage.getItem(KEY)),
  toggle: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark'
    window.localStorage.setItem(KEY, theme)
    set({ theme })
  },
}))

/**
 * Keeps the root element's `data-theme` on the theme, and follows a choice made in another window of the app through the
 * storage they share, so a pop out follows the main window's toggle. Each window's root calls it once.
 */
export function useWindowTheme() {
  useEffect(() => {
    // Another window may have saved a choice after this module loaded and before this listener starts.
    useTheme.setState({ theme: parse(window.localStorage.getItem(KEY)) })
    const root = document.documentElement
    root.dataset.theme = useTheme.getState().theme
    const unsubscribe = useTheme.subscribe(({ theme }) => {
      root.dataset.theme = theme
    })
    const follow = (event: StorageEvent) => {
      if (event.key === KEY) useTheme.setState({ theme: parse(event.newValue) })
    }
    window.addEventListener('storage', follow)
    return () => {
      unsubscribe()
      window.removeEventListener('storage', follow)
    }
  }, [])
}
