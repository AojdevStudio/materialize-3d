import { openUrl } from '@tauri-apps/plugin-opener'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * An agent's words as Markdown: headings, lists, tables, and code. Raw HTML in them shows as its text, never as HTML.
 * A web link opens in the browser, because the app's window must stay on the app. Any other link, and a picture, show
 * as their text.
 */
export default function Markdown({ text, onError }: { text: string; onError: (message: string) => void }) {
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
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  )
}
