import { useEffect, useState } from 'react'
import { modelName } from '../../sidecar/src/offered'
import type { Settings, Toolchain } from '../../sidecar/src/protocol'
import { checkSlicer, sidecar, type SlicerCheck } from './api'
import type { StepProps } from './Setup'
import { AGENTS } from './SetupCheck'

const CHECKING = 'Checking…'

function agentLine({ model, astra }: Settings): string {
  const agent = AGENTS.find((entry) => entry.provider === model.provider)
  const runs = agent === undefined ? `${modelName(model)}.` : `${agent.name}, ${modelName(model)}.`
  return astra ? `${runs} Astra helps with drawings.` : runs
}

const slicerLine = (slicer: SlicerCheck) => (slicer.found === 'ready' ? 'Bambu Studio' : 'Not found. You get guides and STL files, but no 3MF.')

function toolsLine(toolchain: Toolchain): string {
  if (toolchain.uv === null) return 'uv is missing.'
  return toolchain.python === null ? `uv ${toolchain.uv}, no Python` : `uv ${toolchain.uv}, Python ${toolchain.python}`
}

/** The end of setup: what new chats run with, and Start a project. Each line fills in as its part answers. */
export default function SetupReady({ next, onError }: StepProps) {
  const [agent, setAgent] = useState(CHECKING)
  const [slicer, setSlicer] = useState(CHECKING)
  const [tools, setTools] = useState(CHECKING)

  useEffect(() => {
    let current = true
    const fill = <T,>(answer: Promise<T>, line: (value: T) => string, set: (text: string) => void) =>
      void answer.then(
        (value) => current && set(line(value)),
        (err: unknown) => current && onError(String(err)),
      )
    fill(sidecar('state.get', {}), ({ settings }) => agentLine(settings), setAgent)
    fill(checkSlicer(), slicerLine, setSlicer)
    fill(sidecar('setup.tools', {}), toolsLine, setTools)
    return () => {
      current = false
    }
  }, [])

  const rows = [
    { id: 'agent', label: 'Agent', text: agent },
    { id: 'slicer', label: 'Slicer', text: slicer },
    { id: 'tools', label: 'Build tools', text: tools },
  ]

  return (
    <>
      <h1>You’re set up</h1>
      <p>Change any of this later in Settings.</p>
      <dl className="setup-summary">
        {rows.map(({ id, label, text }) => (
          <div key={id} data-testid={`ready-${id}`}>
            <dt>{label}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <div className="setup-actions">
        <button type="button" className="primary" onClick={next}>
          Start a project
        </button>
      </div>
    </>
  )
}
