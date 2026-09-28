import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { pickFile } from '../lib/fileDialog'

interface FoundBuild {
  path: string
  /** `null` when the app did not report a version. */
  version: string | null
}

/** Mirrors `StudioStatus` in `src-tauri/src/fabrication/bambu/studio.rs`. */
export type BambuStudioStatus = (
  | { state: 'found'; path: string; version: string }
  | { state: 'unvalidated'; builds: FoundBuild[] }
  | { state: 'not_found'; detail: string }
) & {
  /** The app chosen here, if any. */
  chosenPath: string | null
  validatedVersions: string[]
  downloadUrl: string
}

const breakAnywhere = { overflowWrap: 'anywhere' } as const

/**
 * The Bambu Studio build that slices signs. Shows what the app found and, when
 * it is missing or unvalidated, how to install the validated build beside any
 * other version and choose it. The app never installs or moves Bambu Studio.
 */
export function BambuStudioSection({ active }: { active: boolean }) {
  const [status, setStatus] = useState<BambuStudioStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!active) return
    invoke<BambuStudioStatus>('bambu_studio_status').then(setStatus, (err) => setError(String(err)))
  }, [active])

  const run = async (action: () => Promise<BambuStudioStatus | null>) => {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      if (next) setStatus(next)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const choose = () =>
    run(async () => {
      const path = await pickFile({ title: 'Choose Bambu Studio' })
      return path === null ? null : invoke<BambuStudioStatus>('choose_bambu_studio', { path })
    })

  const clear = () => run(() => invoke<BambuStudioStatus>('clear_bambu_studio'))

  return (
    <div className="settings-section" data-testid="bambu-studio-section">
      <div className="settings-section-label">Bambu Studio</div>
      {status && <StudioState status={status} />}
      <div className="settings-actions">
        <button type="button" disabled={busy || !status} onClick={() => void choose()} data-testid="bambu-studio-choose">
          Choose Bambu Studio…
        </button>
        {status?.chosenPath && (
          <button type="button" disabled={busy} onClick={() => void clear()} data-testid="bambu-studio-clear">
            Clear choice
          </button>
        )}
      </div>
      {error && (
        <div className="settings-slicer-warning" role="alert" style={breakAnywhere}>
          {error}
        </div>
      )}
    </div>
  )
}

function StudioState({ status }: { status: BambuStudioStatus }) {
  if (status.state === 'found') {
    return (
      <>
        <div className="settings-slicer-ok" data-testid="bambu-studio-found">
          Bambu Studio {status.version} ✓
        </div>
        <div className="settings-hint" data-testid="bambu-studio-path" style={breakAnywhere}>
          {status.path}
        </div>
      </>
    )
  }

  const version = status.validatedVersions.join(' or ')
  return (
    <>
      <div className="settings-slicer-warning" data-testid="bambu-studio-problem" style={breakAnywhere}>
        {status.state === 'unvalidated'
          ? status.builds.map((build) => (
              <div key={build.path}>
                Found {build.version ?? 'an unknown version'} at {build.path}. Signs need {version}.
              </div>
            ))
          : status.detail.charAt(0).toUpperCase() + status.detail.slice(1)}
      </div>
      <ol className="settings-hint" data-testid="bambu-studio-steps">
        <li>
          Download{' '}
          <a href={status.downloadUrl} target="_blank" rel="noopener noreferrer">
            Bambu Studio {version}
          </a>
          .
        </li>
        <li>
          If you use another Bambu Studio version, put this one in its own folder, such as
          Applications/BambuStudio-{status.validatedVersions[0]}/, so it does not replace yours.
        </li>
        <li>Choose it here.</li>
      </ol>
    </>
  )
}
