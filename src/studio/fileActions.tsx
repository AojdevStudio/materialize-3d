import { studio } from './api'

const isMac = navigator.userAgent.includes('Mac')

/** Runs a file action, and shows its failure in the error bar. */
export const reporting = (onError: (message: string) => void) => (action: Promise<void>) =>
  action.catch((err: unknown) => onError(String(err)))

/** Shows a project file in the system file manager. */
export function RevealButton({ project, rel, onError }: { project: string; rel: string; onError: (message: string) => void }) {
  return (
    <button type="button" onClick={() => reporting(onError)(studio.reveal(project, rel))}>
      {isMac ? 'Reveal in Finder' : 'Show in folder'}
    </button>
  )
}
