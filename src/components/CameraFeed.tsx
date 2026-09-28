import { useCallback, useState } from 'react'
import { usePrinterStore } from '../stores/printer'

/**
 * CameraFeed — renders a JPEG snapshot from the printer camera or a clear
 * "Camera Unavailable" placeholder with diagnostic info.
 *
 * Architecturally isolated: the monitor from T01 is fully functional without this.
 */
export function CameraFeed() {
  const cameraState = usePrinterStore((s) => s.cameraState)
  const [imgKey, setImgKey] = useState(0)
  const [imgError, setImgError] = useState(false)

  const handleRefresh = useCallback(() => {
    setImgError(false)
    setImgKey((k) => k + 1)
  }, [])

  const handleImgError = useCallback(() => {
    setImgError(true)
  }, [])

  // Available — render camera image
  if (cameraState.status === 'available' && cameraState.url) {
    return (
      <div className="camera-feed" data-testid="camera-feed">
        <div className="camera-feed-header">
          <span className="camera-feed-label">Camera Feed</span>
          <button
            className="camera-refresh-btn"
            onClick={handleRefresh}
            title="Refresh snapshot"
            data-testid="camera-refresh"
          >
            ↻
          </button>
        </div>
        {imgError ? (
          <div className="camera-img-error" data-testid="camera-img-error">
            <span className="camera-off-icon">📷</span>
            <span className="camera-error-text">Failed to load snapshot</span>
            <button className="camera-retry-btn" onClick={handleRefresh}>
              Retry
            </button>
          </div>
        ) : (
          <img
            key={imgKey}
            className="camera-image"
            src={`${cameraState.url}?t=${imgKey}`}
            alt="Printer camera feed"
            data-testid="camera-image"
            onError={handleImgError}
          />
        )}
      </div>
    )
  }

  // Probing — pulsing indicator
  if (cameraState.status === 'probing') {
    return (
      <div className="camera-feed camera-feed--probing" data-testid="camera-feed">
        <div className="camera-probing-indicator" data-testid="camera-probing">
          <span className="camera-probing-dot" />
          <span className="camera-probing-text">Checking camera...</span>
        </div>
        {cameraState.diagnostic && (
          <p className="camera-diagnostic">{cameraState.diagnostic}</p>
        )}
      </div>
    )
  }

  // Unavailable or Error — styled placeholder
  return (
    <div className="camera-feed camera-feed--unavailable" data-testid="camera-feed">
      <div className="camera-unavailable-content">
        <span className="camera-off-icon" data-testid="camera-off-icon">
          📷
        </span>
        <h3 className="camera-unavailable-heading">Camera Unavailable</h3>
        {cameraState.diagnostic && (
          <p className="camera-diagnostic" data-testid="camera-diagnostic">
            {cameraState.diagnostic}
          </p>
        )}
      </div>
    </div>
  )
}

export default CameraFeed
