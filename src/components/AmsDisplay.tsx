import { usePrinterStore, type AmsUnitState, type AmsTrayState } from '../stores/printer'

function TraySwatch({ tray }: { tray: AmsTrayState }) {
  const hasFilament = tray.trayColor != null && tray.trayColor !== ''
  const bgColor = hasFilament ? `#${tray.trayColor}` : 'var(--filament-empty)'
  const typeLabel = tray.trayType || '—'

  return (
    <div className="ams-tray" data-testid="ams-tray">
      <div
        className="ams-swatch"
        style={{ backgroundColor: bgColor }}
        aria-label={hasFilament ? `Filament color #${tray.trayColor}` : 'Empty slot'}
      />
      <span className="ams-tray-type">{typeLabel}</span>
    </div>
  )
}

function AmsUnit({ unit }: { unit: AmsUnitState }) {
  return (
    <div className="ams-unit" data-testid="ams-unit">
      <div className="ams-unit-label">AMS {unit.id != null ? unit.id + 1 : '?'}</div>
      <div className="ams-tray-row">
        {unit.trays.map((tray, idx) => (
          <TraySwatch key={tray.trayId ?? idx} tray={tray} />
        ))}
      </div>
    </div>
  )
}

export function AmsDisplay() {
  const amsState = usePrinterStore((s) => s.amsState)

  if (!amsState || amsState.length === 0) {
    return (
      <div className="ams-display ams-display--empty" data-testid="ams-display">
        <div className="ams-display-label">AMS</div>
        <div className="ams-empty-message">No AMS detected</div>
      </div>
    )
  }

  return (
    <div className="ams-display" data-testid="ams-display">
      <div className="ams-display-label">AMS</div>
      {amsState.map((unit, idx) => (
        <AmsUnit key={unit.id ?? idx} unit={unit} />
      ))}
    </div>
  )
}

export default AmsDisplay
