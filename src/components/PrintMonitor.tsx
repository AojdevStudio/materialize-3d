import { usePrinterStore } from '../stores/printer'
import { TemperatureGauge } from './TemperatureGauge'
import { AmsDisplay } from './AmsDisplay'
import { CameraFeed } from './CameraFeed'

// --- GcodeStateBadge ---

const GCODE_STATE_MAP: Record<string, { label: string; className: string }> = {
  IDLE: { label: 'Idle', className: 'gcode-badge--idle' },
  RUNNING: { label: 'Printing', className: 'gcode-badge--running' },
  PAUSE: { label: 'Paused', className: 'gcode-badge--pause' },
  FINISH: { label: 'Finished', className: 'gcode-badge--finish' },
  FAILED: { label: 'Failed', className: 'gcode-badge--failed' },
  PREPARE: { label: 'Preparing', className: 'gcode-badge--prepare' },
}

export function GcodeStateBadge({ state }: { state: string | null }) {
  const mapped = state ? GCODE_STATE_MAP[state] : null
  const label = mapped?.label ?? state ?? 'Unknown'
  const className = mapped?.className ?? 'gcode-badge--unknown'

  return (
    <span className={`gcode-badge ${className}`} data-testid="gcode-badge">
      {label}
    </span>
  )
}

// --- PrintProgress ---

function formatRemainingTime(minutes: number | null): string {
  if (minutes == null || minutes <= 0) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function PrintProgress({
  progress,
  layerNum,
  totalLayerNum,
  remainingTime,
  gcodeState,
}: {
  progress: number | null
  layerNum: number | null
  totalLayerNum: number | null
  remainingTime: number | null
  gcodeState: string | null
}) {
  const isActive = gcodeState === 'RUNNING' || gcodeState === 'PAUSE' || gcodeState === 'PREPARE'
  const pct = progress != null ? Math.min(100, Math.max(0, progress)) : 0

  return (
    <div className="print-progress" data-testid="print-progress">
      <div className="print-progress-header">
        <span className="print-progress-label">Print Progress</span>
        <span className="print-progress-pct">{progress != null ? `${pct}%` : '—'}</span>
      </div>
      <div className="progress-bar">
        <div
          className="progress-fill"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
      <div className="print-progress-details">
        {isActive ? (
          <>
            <span data-testid="layer-count">
              Layer {layerNum ?? '—'} / {totalLayerNum ?? '—'}
            </span>
            <span data-testid="remaining-time">
              ETA: {formatRemainingTime(remainingTime)}
            </span>
          </>
        ) : (
          <span className="print-progress-idle">No active print</span>
        )}
      </div>
    </div>
  )
}

// --- PrintMonitor (composition root) ---

export function PrintMonitor() {
  const nozzleTemp = usePrinterStore((s) => s.nozzleTemp)
  const nozzleTargetTemp = usePrinterStore((s) => s.nozzleTargetTemp)
  const bedTemp = usePrinterStore((s) => s.bedTemp)
  const bedTargetTemp = usePrinterStore((s) => s.bedTargetTemp)
  const chamberTemp = usePrinterStore((s) => s.chamberTemp)
  const gcodeState = usePrinterStore((s) => s.gcodeState)
  const printProgress = usePrinterStore((s) => s.printProgress)
  const remainingTime = usePrinterStore((s) => s.remainingTime)
  const layerNum = usePrinterStore((s) => s.layerNum)
  const totalLayerNum = usePrinterStore((s) => s.totalLayerNum)

  return (
    <div className="print-monitor" data-testid="print-monitor">
      {/* Status header */}
      <div className="print-monitor-header">
        <h2 className="print-monitor-title">Print Monitor</h2>
        <GcodeStateBadge state={gcodeState} />
      </div>

      {/* Temperature gauges row */}
      <div className="temp-gauges-row">
        <TemperatureGauge label="Nozzle" current={nozzleTemp} target={nozzleTargetTemp} />
        <TemperatureGauge label="Bed" current={bedTemp} target={bedTargetTemp} />
        <TemperatureGauge label="Chamber" current={chamberTemp} target={null} />
      </div>

      {/* Print progress */}
      <PrintProgress
        progress={printProgress}
        layerNum={layerNum}
        totalLayerNum={totalLayerNum}
        remainingTime={remainingTime}
        gcodeState={gcodeState}
      />

      {/* AMS display */}
      <AmsDisplay />

      {/* Camera feed */}
      <CameraFeed />
    </div>
  )
}

export default PrintMonitor
