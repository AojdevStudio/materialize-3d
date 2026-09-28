import { usePrinterStore } from '../stores/printer'

interface StatusBarProps {
  version?: string
}

function formatEta(minutes: number | null): string | null {
  if (minutes == null || minutes <= 0) return null
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

export function StatusBar({ version = 'v0.1.0' }: StatusBarProps) {
  const connectionState = usePrinterStore((s) => s.connectionState)
  const printerName = usePrinterStore((s) => s.name) ?? 'No Printer'
  const nozzleTemp = usePrinterStore((s) => s.nozzleTemp)
  const bedTemp = usePrinterStore((s) => s.bedTemp)
  const chamberTemp = usePrinterStore((s) => s.chamberTemp)
  const gcodeState = usePrinterStore((s) => s.gcodeState)
  const printProgress = usePrinterStore((s) => s.printProgress)
  const remainingTime = usePrinterStore((s) => s.remainingTime)
  const layerNum = usePrinterStore((s) => s.layerNum)
  const totalLayerNum = usePrinterStore((s) => s.totalLayerNum)

  const isConnected = connectionState === 'connected_mqtt' || connectionState === 'connected_cloud'

  const tempLabel = `🌡 N ${nozzleTemp ?? '—'} °C · B ${bedTemp ?? '—'} °C${chamberTemp != null ? ` · C ${chamberTemp} °C` : ''}`

  const isPrinting = gcodeState != null && gcodeState !== 'IDLE' && gcodeState !== '' && gcodeState !== 'FINISH'
  const eta = formatEta(remainingTime)
  const layerInfo = layerNum != null && totalLayerNum != null ? `L${layerNum}/${totalLayerNum}` : null

  const connectionLabel = isConnected ? 'Online' : connectionState === 'reconnecting' ? 'Reconnecting' : 'Offline'

  return (
    <footer className="status-bar">
      <div className="status-item">
        <strong>{version}</strong>
      </div>

      {isConnected && gcodeState && (
        <div className="status-item">{gcodeState}</div>
      )}

      {isPrinting && printProgress != null && (
        <div className="status-item">
          {printProgress}%{eta ? ` · ETA ${eta}` : ''}{layerInfo ? ` · ${layerInfo}` : ''}
        </div>
      )}

      <div className="status-spacer" />

      <div className="status-item status-temp">{tempLabel}</div>
      <div className="status-item status-online">{connectionLabel} · {printerName}</div>
    </footer>
  )
}

export default StatusBar
