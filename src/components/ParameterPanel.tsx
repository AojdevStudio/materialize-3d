/**
 * ParameterPanel — renders OpenSCAD customizer parameters as sliders and inputs.
 *
 * Features:
 * - Number params with min/max → range slider with value display
 * - String params → text input
 * - Boolean params → checkbox
 * - Parameters grouped by their `group` field
 * - Debounced re-render on parameter change (300ms)
 */
import { useCallback, useMemo } from 'react'
import { useOpenScadStore, debouncedRender } from '../stores/openscadStore'
import type { ScadParameter } from '../stores/openscadStore'
import styles from './ParameterPanel.module.css'

/** Group parameters by their group field, preserving declaration order */
function groupParameters(params: ScadParameter[]): Map<string, ScadParameter[]> {
  const groups = new Map<string, ScadParameter[]>()
  for (const p of params) {
    const key = p.group ?? 'Parameters'
    const list = groups.get(key)
    if (list) {
      list.push(p)
    } else {
      groups.set(key, [p])
    }
  }
  return groups
}

function ParameterInput({ param }: { param: ScadParameter }) {
  const updateParameter = useOpenScadStore((s) => s.updateParameter)

  const handleChange = useCallback(
    (value: number | string | boolean) => {
      updateParameter(param.name, value)
      debouncedRender()
    },
    [param.name, updateParameter],
  )

  const label = param.caption ?? param.name

  if (param.type === 'number') {
    const hasRange = param.min != null && param.max != null
    const value = typeof param.initial === 'number' ? param.initial : Number(param.initial) || 0
    const step = param.step ?? (hasRange ? (Number(param.max!) - Number(param.min!)) / 100 : 1)

    if (hasRange) {
      return (
        <div className={styles.paramRow}>
          <label className={styles.paramLabel} title={param.name}>
            {label}
          </label>
          <div className={styles.sliderGroup}>
            <input
              type="range"
              className={styles.slider}
              min={param.min!}
              max={param.max!}
              step={step}
              value={value}
              onChange={(e) => handleChange(Number(e.target.value))}
              aria-label={label}
            />
            <span className={styles.paramValue}>{value}</span>
          </div>
        </div>
      )
    }

    // Number without range — plain number input
    return (
      <div className={styles.paramRow}>
        <label className={styles.paramLabel} title={param.name}>
          {label}
        </label>
        <input
          type="number"
          className={styles.numberInput}
          value={value}
          step={step}
          onChange={(e) => handleChange(Number(e.target.value))}
          aria-label={label}
        />
      </div>
    )
  }

  if (param.type === 'boolean') {
    const checked = param.initial === true || param.initial === 'true'
    return (
      <div className={styles.paramRow}>
        <label className={styles.paramLabel} title={param.name}>
          {label}
        </label>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={checked}
          onChange={(e) => handleChange(e.target.checked)}
          aria-label={label}
        />
      </div>
    )
  }

  // Default: string input
  const strValue = String(param.initial ?? '')
  return (
    <div className={styles.paramRow}>
      <label className={styles.paramLabel} title={param.name}>
        {label}
      </label>
      <input
        type="text"
        className={styles.textInput}
        value={strValue}
        onChange={(e) => handleChange(e.target.value)}
        aria-label={label}
      />
    </div>
  )
}

export default function ParameterPanel() {
  const parameters = useOpenScadStore((s) => s.parameters)

  const grouped = useMemo(() => groupParameters(parameters), [parameters])

  if (parameters.length === 0) {
    return (
      <div className={styles.panel} data-testid="parameter-panel">
        <div className={styles.emptyState}>No parameters</div>
      </div>
    )
  }

  return (
    <div className={styles.panel} data-testid="parameter-panel">
      <div className={styles.header}>Parameters</div>
      {[...grouped.entries()].map(([group, params]) => (
        <div key={group} className={styles.group}>
          {grouped.size > 1 && (
            <div className={styles.groupHeader}>{group}</div>
          )}
          {params.map((p) => (
            <ParameterInput key={p.name} param={p} />
          ))}
        </div>
      ))}
    </div>
  )
}
