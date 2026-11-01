import { dismissUpdate, installUpdate, useUpdateStore, waitingMessage, type UpdateProgress } from '../stores/updates'
import styles from './UpdateBanner.module.css'

export function formatProgress(progress: UpdateProgress | null): string {
  if (!progress) return 'Downloading…'
  const mb = (bytes: number) => (bytes / 1_000_000).toFixed(0)
  return progress.total
    ? `Downloading… ${mb(progress.downloaded)} of ${mb(progress.total)} MB`
    : `Downloading… ${mb(progress.downloaded)} MB`
}

/**
 * The strip under the toolbar that offers a newer release. Nothing installs
 * until Update now is clicked. Later hides it until the next launch.
 */
export function UpdateBanner() {
  const { phase, available, error, failed, progress, waitingFor, dismissed } = useUpdateStore()
  if (dismissed) return null
  if (phase === 'error' && error) {
    const installFailed = failed === 'install' && available
    return (
      <div className={styles.banner} role="alert" data-testid="update-banner">
        <div className={styles.text}>
          <strong>{installFailed ? `Materialize 3D ${available.version} did not install.` : 'Could not check for updates.'}</strong>
          <span className={styles.error} data-testid="update-error">{error}</span>
          <span>The current version keeps running.</span>
        </div>
        <div className={styles.actions}>
          {installFailed && (
            <button type="button" className={styles.primary} onClick={() => void installUpdate()}>
              Try again
            </button>
          )}
          <button type="button" onClick={dismissUpdate}>
            {installFailed ? 'Later' : 'Dismiss'}
          </button>
        </div>
      </div>
    )
  }
  if (!available || (phase !== 'available' && phase !== 'installing')) return null
  const installing = phase === 'installing'
  return (
    <div className={styles.banner} role="status" data-testid="update-banner">
      <div className={styles.text}>
        <strong data-testid="update-version">Materialize 3D {available.version} is available.</strong>
        <span>You have {available.currentVersion}.</span>
        {installing && (
          <span data-testid="update-progress">
            {waitingFor > 0 ? waitingMessage(waitingFor) : `${formatProgress(progress)} The app restarts when the update is installed.`}
          </span>
        )}
        {available.notes && !installing && (
          <details className={styles.notes}>
            <summary>What's new</summary>
            <div data-testid="update-notes">{available.notes}</div>
          </details>
        )}
      </div>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={installing} onClick={() => void installUpdate()} data-testid="update-now">
          {installing ? 'Updating…' : 'Update now'}
        </button>
        <button type="button" disabled={installing} onClick={dismissUpdate} data-testid="update-later">
          Later
        </button>
      </div>
    </div>
  )
}

export default UpdateBanner
