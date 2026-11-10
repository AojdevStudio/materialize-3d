import { openUrl } from '@tauri-apps/plugin-opener'
import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

/**
 * An agent's words as Markdown: headings, lists, tables, and code. A single newline stays a line break, as the agent
 * typed it. Raw HTML in them shows as its text, never as HTML. A web link opens in the browser, because the app's
 * window must stay on the app. Any other link, and a picture, show as their text. It parses again only when its text
 * changes, not on each keystroke in the composer.
 */
function Markdown({ text, onError }: { text: string; onError: (message: string) => void }) {
  const components: Components = {
    a: ({ href, children }) =>
      href !== undefined && /^https?:\/\//i.test(href) ? (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault()
            void openUrl(href).catch((err: unknown) => onError(String(err)))
          }}
        >
          {children}
        </a>
      ) : (
        <>{children}</>
      ),
    img: ({ alt }) => alt,
  }
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {text}
    </ReactMarkdown>
  )
}

export default memo(Markdown)
