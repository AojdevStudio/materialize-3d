import { useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { checkForUpdates, installUpdate, useUpdateStore } from '../stores/updates'

/** Settings > About: the installed version and a manual update check. */
export function AboutSection({ active }: { active: boolean }) {
  const [version, setVersion] = useState<string | null>(null)
  const { phase, available, error } = useUpdateStore()

  useEffect(() => {
    if (!active) return
    getVersion().then(setVersion, () => setVersion(null))
  }, [active])

  const checking = phase === 'checking'
  const installing = phase === 'installing'

  return (
    <div className="settings-section" data-testid="about-section">
      <div className="settings-section-label">About</div>
      <div className="settings-hint" data-testid="about-version">
        Materialize 3D {version ?? 'version unknown'}
      </div>
      <div className="settings-actions">
        <button type="button" disabled={checking || installing} onClick={() => void checkForUpdates()} data-testid="about-check">
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        {available && (phase === 'available' || phase === 'error') && (
          <button type="button" onClick={() => void installUpdate()} data-testid="about-update-now">
            Update now
          </button>
        )}
      </div>
      <div className="settings-hint" data-testid="about-status" role={phase === 'error' ? 'alert' : undefined}>
        {phase === 'upToDate' && 'Materialize 3D is up to date.'}
        {phase === 'available' && available && `Version ${available.version} is available.`}
        {installing && 'Installing the update. The app restarts when it is done.'}
        {phase === 'error' && error}
      </div>
    </div>
  )
}

export default AboutSection
