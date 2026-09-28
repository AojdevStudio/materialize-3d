interface TemperatureGaugeProps {
  label: string
  current: number | null
  target: number | null
}

function getHeatingState(
  current: number | null,
  target: number | null,
): 'heating' | 'at-target' | 'idle' {
  if (target == null || target === 0) return 'idle'
  if (current == null) return 'heating'
  if (Math.abs(current - target) <= 2) return 'at-target'
  return current < target ? 'heating' : 'idle'
}

export function TemperatureGauge({ label, current, target }: TemperatureGaugeProps) {
  const state = getHeatingState(current, target)

  return (
    <div className={`temp-gauge temp-gauge--${state}`} data-testid={`temp-gauge-${label.toLowerCase()}`}>
      <div className="temp-gauge-label">{label}</div>
      <div className="temp-gauge-value">
        {current != null ? `${Math.round(current)}°C` : '—'}
      </div>
      <div className="temp-gauge-target">
        {target != null && target > 0 ? `Target: ${Math.round(target)}°C` : 'Off'}
      </div>
      {state === 'heating' && (
        <div className="temp-gauge-heating" data-testid="heating-indicator">▲ Heating</div>
      )}
      {state === 'at-target' && (
        <div className="temp-gauge-at-target" data-testid="at-target-indicator">● Ready</div>
      )}
    </div>
  )
}

export default TemperatureGauge
