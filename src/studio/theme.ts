import { create } from 'zustand'

export type Theme = 'light' | 'dark'

/** Where the person's choice is kept, in this app's own webview storage, so it outlives a restart. */
const KEY = 'materialize-3d.theme'

type ThemeState = { theme: Theme; toggle: () => void }

const parse = (saved: string | null): Theme => (saved === 'dark' ? 'dark' : 'light')

/**
 * The app's theme. Light unless the person chose dark. Read it with `useTheme((s) => s.theme)`, or follow it outside
 * React with `useTheme.subscribe`. The root element's `data-theme` always matches it.
 */
export const useTheme = create<ThemeState>()((set, get) => ({
  theme: parse(window.localStorage.getItem(KEY)),
  toggle: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark'
    window.localStorage.setItem(KEY, theme)
    set({ theme })
  },
}))

// index.html sets it before the first paint. This keeps it set where that script did not run, as in tests.
document.documentElement.dataset.theme = useTheme.getState().theme
useTheme.subscribe(({ theme }) => {
  document.documentElement.dataset.theme = theme
})
// A choice made in another window of the app reaches this one through the storage they share, so a pop out follows the
// main window's toggle.
window.addEventListener('storage', (event) => {
  if (event.key === KEY) useTheme.setState({ theme: parse(event.newValue) })
})
