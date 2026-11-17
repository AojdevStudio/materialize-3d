import { useEffect, useRef, useState } from 'react'
import { fileUrl } from './api'
import { extensionOf, fileKind } from './files'
import ModelView from './ModelView'
import { FRAME_THEME, useTheme, type Theme } from './theme'

function TextView({ url }: { url: string }) {
  const [text, setText] = useState('')
  useEffect(() => {
    let live = true
    fetch(url)
      .then((r) => r.text())
      .then((t) => live && setText(t))
      .catch((err: unknown) => live && setText(String(err)))
    return () => {
      live = false
    }
  }, [url])
  return <pre className="text-view">{text}</pre>
}

const postTheme = (frame: HTMLIFrameElement | null, theme: Theme) => frame?.contentWindow?.postMessage({ type: FRAME_THEME.message, theme }, '*')

/**
 * A page in a frame, which cannot read the app's theme. The app owns it: the page opens in the theme named in its
 * address, and each later change is posted to it, so a guide made from the template flips without a reload and keeps
 * its step. A page that has loaded gets the theme once more, in case it changed while the page loaded.
 */
function HtmlFrame({ url, title }: { url: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [opened] = useState(() => useTheme.getState().theme)
  useEffect(() => useTheme.subscribe(({ theme }) => postTheme(frame.current, theme)), [])
  return (
    <iframe
      ref={frame}
      title={title}
      src={`${url}${url.includes('?') ? '&' : '?'}${FRAME_THEME.query}=${opened}`}
      onLoad={(event) => postTheme(event.currentTarget, useTheme.getState().theme)}
      sandbox="allow-scripts allow-same-origin allow-modals"
      data-testid="html-preview"
    />
  )
}

/** A project file as the panel and a pop out show it, loaded from its project, so its relative links work. */
export default function FileBody({ project, rel, version }: { project: string; rel: string; version?: number }) {
  const url = fileUrl(project, rel, version)
  switch (fileKind(rel)) {
    case 'html':
      // A new version is a new frame, which opens in the theme of that moment.
      return <HtmlFrame key={url} url={url} title={rel} />
    case 'model':
      return <ModelView url={url} ext={extensionOf(rel)} />
    case 'image':
      return <img className="image-view" src={url} alt={rel} />
    case 'text':
      return <TextView url={url} />
    case 'other':
      return <p className="preview-note">No preview for this file.</p>
  }
}
