import { invoke } from '@tauri-apps/api/core'
import { pickSaveTarget } from '../../lib/fileDialog'
import { useEffect, useState, type ReactNode } from 'react'
import { useDesignsStore } from '../../stores/designs'
import { buildWarnings, revisionArtifacts, type Artifacts, type Revision, type RevisionId, type Sha256Hex } from '../../types/designs'
import { RevisionRows } from './RevisionRows'
import {
  approvalAxis,
  approveBlockedReason,
  buildAxis,
  checkRows,
  exportFileName,
  printAxis,
  shortHash,
  type StateWord,
} from './designFormat'
import styles from './DesignsView.module.css'

/** Default thickness the backend applies when a spec omits `thickness_mm`. */
const DEFAULT_THICKNESS_MM = 2.6

type PreviewState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; message: string }

/** Loads `design_preview` PNG bytes into an object URL, revoked when the revision changes or the view unmounts. */
function usePreview(id: RevisionId, hasPreview: boolean): PreviewState {
  const [preview, setPreview] = useState<PreviewState>({ status: 'none' })

  useEffect(() => {
    if (!hasPreview) {
      setPreview({ status: 'none' })
      return
    }
    let disposed = false
    let url: string | null = null
    setPreview({ status: 'loading' })
    invoke<ArrayBuffer>('design_preview', { id })
      .then((bytes) => {
        if (disposed) return
        url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        setPreview({ status: 'ready', url })
      })
      .catch((error: unknown) => {
        if (!disposed) setPreview({ status: 'error', message: String(error) })
      })
    return () => {
      disposed = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [id, hasPreview])

  return preview
}

function Word({ word }: { word: StateWord }) {
  return <span className={styles[word.tone]}>{word.text}</span>
}

function sizeText(revision: Revision): string {
  const { width_mm, height_mm, thickness_mm = DEFAULT_THICKNESS_MM } = revision.spec
  return `${width_mm} x ${height_mm} x ${thickness_mm} mm`
}

function DesignPreview({ revision }: { revision: Revision }) {
  const preview = usePreview(revision.id, revisionArtifacts(revision) !== null)

  return (
    <div className={styles.preview}>
      {preview.status === 'ready' ? (
        <img
          data-testid="sign-preview"
          className={styles.previewImg}
          src={preview.url}
          alt={`Finished face of r${revision.number}`}
        />
      ) : preview.status === 'error' ? (
        <span className={styles.bad}>{preview.message}</span>
      ) : preview.status === 'none' ? (
        <span className={styles.muted}>No preview for this revision</span>
      ) : null}
      <span className={styles.muted}>Finished face, {sizeText(revision)}</span>
    </div>
  )
}

function FactRow({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <tr data-testid={testId}>
      <th scope="row">{label}</th>
      <td>{children}</td>
    </tr>
  )
}

/** The three independent axes, one row each. None is derived from another. */
function Axes({ revision }: { revision: Revision }) {
  const rows = [
    ['Sliced and verified', 'axis-build', buildAxis(revision)],
    ['Print-tested', 'axis-print', printAxis(revision)],
    ['Approval', 'axis-approval', approvalAxis(revision)],
  ] as const

  return (
    <table className={`${styles.table} ${styles.facts}`}>
      <tbody>
        {rows.map(([label, testId, { word, note }]) => (
          <FactRow key={testId} label={label} testId={testId}>
            <Word word={word} /> <span className={styles.muted}>{note}</span>
          </FactRow>
        ))}
      </tbody>
    </table>
  )
}

function ChecksTable({ artifacts }: { artifacts: Artifacts }) {
  const rows = checkRows(artifacts.checks)
  // Warnings are listed, not counted: they never fail a build.
  const blocking = artifacts.checks.filter((check) => !check.advisory)
  const passed = blocking.filter((check) => check.passed).length
  const allPassed = passed === blocking.length

  return (
    <>
      <h2 className={styles.sectionTitle}>
        Checks <span className={allPassed ? styles.ok : styles.bad}>{passed} of {blocking.length}</span>
      </h2>
      <table className={`${styles.table} ${styles.checks}`} data-testid="sign-checks">
        <thead>
          <tr>
            <th>Result</th>
            <th>Stage</th>
            <th>Check</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-check={row.key} title={row.title}>
              <td className={row.passed ? styles.ok : row.warning ? styles.muted : styles.bad}>
                {row.passed ? 'Pass' : row.warning ? 'Warning' : 'Fail'}
              </td>
              <td className={styles.muted}>{row.stage}</td>
              <td>{row.label}</td>
              <td className={styles.muted}>{row.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Materials({ revision, artifacts }: { revision: Revision; artifacts: Artifacts | null }) {
  const effective = artifacts?.effective_settings ?? null
  const slots = [revision.spec.base, ...revision.spec.inks]

  return (
    <>
      <h2 className={styles.sectionTitle}>Materials and slicer</h2>
      <table className={`${styles.table} ${styles.facts}`}>
        <tbody>
          <FactRow label="Size">{sizeText(revision)}</FactRow>
          {slots.map((ink, index) => (
            <FactRow key={ink.name} label={`Slot ${index + 1}`}>
              <i className={styles.swatch} style={{ background: ink.hex }} aria-hidden="true" />
              {[ink.name, effective?.filament_settings_id[index], index === 0 ? 'base' : 'inlay', ink.hex.toUpperCase()]
                .filter(Boolean)
                .join(', ')}
            </FactRow>
          ))}
          {artifacts && (
            <FactRow label="Slicer">
              {artifacts.slicer.name} {artifacts.slicer.version}{' '}
              <span className={styles.muted}>profiles {artifacts.slicer.profile_version}</span>
            </FactRow>
          )}
          {effective && (
            <>
              <FactRow label="Machine">{effective.printer_settings_id}</FactRow>
              <FactRow label="Process">{effective.print_settings_id}</FactRow>
            </>
          )}
          {artifacts && !effective && <FactRow label="Machine">Not exported by the slicer</FactRow>}
        </tbody>
      </table>
    </>
  )
}

function HashCell({ hash }: { hash: Sha256Hex }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 900)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <span className={styles.hash}>
      <code className={styles.mono} title={hash}>
        {shortHash(hash)}
      </code>
      <button
        type="button"
        className={`${styles.btn} ${styles.small}`}
        onClick={() => void navigator.clipboard?.writeText(hash).then(() => setCopied(true))}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

function Hashes({ artifacts }: { artifacts: Artifacts }) {
  return (
    <>
      <h2 className={styles.sectionTitle}>Hashes</h2>
      <table className={`${styles.table} ${styles.facts}`}>
        <tbody>
          <FactRow label="Package SHA-256" testId="hash-package">
            <HashCell hash={artifacts.package_sha256} />
          </FactRow>
          <FactRow label="G-code SHA-256" testId="hash-gcode">
            <HashCell hash={artifacts.gcode_sha256} />
          </FactRow>
        </tbody>
      </table>
    </>
  )
}

/**
 * Approve, export, and the physical print result. Approve sends exactly the
 * package hash printed on the button and the warnings the checks table shows;
 * export and print recording appear only once that approval exists.
 */
function Actions({ revision }: { revision: Revision }) {
  const approve = useDesignsStore((state) => state.approve)
  const exportPackage = useDesignsStore((state) => state.exportPackage)
  const recordPrint = useDesignsStore((state) => state.recordPrint)
  const error = useDesignsStore((state) => state.error)
  const [busy, setBusy] = useState(false)
  const [written, setWritten] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const { build, approval } = revision
  const approvableHash = build.status === 'verified' ? build.artifacts.package_sha256 : null
  const warnings = build.status === 'verified' ? buildWarnings(build.artifacts) : []
  const blocked = approveBlockedReason(revision)

  const onExport = () =>
    run(async () => {
      const destination = await pickSaveTarget({
        defaultPath: exportFileName(revision),
        filters: [{ name: '3MF', extensions: ['3mf'] }],
      })
      if (!destination) return
      setWritten(await exportPackage(revision.id, destination))
    })

  return (
    <div className={styles.actions}>
      {approval.status === 'pending' && (
        <div className={styles.actionRow}>
          <button
            type="button"
            data-testid="btn-approve"
            className={`${styles.btn} ${styles.primary}`}
            disabled={approvableHash === null || busy}
            onClick={() => approvableHash && void run(() => approve(revision.id, approvableHash, warnings))}
          >
            {approvableHash ? `Approve r${revision.number} for ${shortHash(approvableHash)}` : `Approve r${revision.number}`}
          </button>
          {blocked && (
            <span className={styles.bad} data-testid="approve-blocked">
              {blocked}
            </span>
          )}
        </div>
      )}

      {approval.status === 'approved' && (
        <>
          <div className={styles.actionRow}>
            <button type="button" data-testid="btn-export" className={styles.btn} disabled={busy} onClick={() => void onExport()}>
              Export 3MF
            </button>
            {written && (
              <span className={styles.muted} data-testid="export-path">
                Wrote <code className={styles.mono}>{written}</code>
              </span>
            )}
          </div>
          <div className={styles.actionRow} data-testid="record-print">
            <span>Record print result</span>
            <span className={styles.dim}>human physical test</span>
            <input
              className={styles.noteInput}
              type="text"
              value={note}
              placeholder="Note (optional)"
              aria-label="Print result note"
              onChange={(event) => setNote(event.target.value)}
            />
            <button
              type="button"
              data-testid="btn-print-passed"
              className={styles.btn}
              disabled={busy}
              onClick={() => void run(() => recordPrint(revision.id, true, note.trim()))}
            >
              Passed
            </button>
            <button
              type="button"
              data-testid="btn-print-failed"
              className={styles.btn}
              disabled={busy}
              onClick={() => void run(() => recordPrint(revision.id, false, note.trim()))}
            >
              Failed
            </button>
          </div>
        </>
      )}

      {error && (
        <div className={styles.bad} data-testid="sign-action-error">
          {error}
        </div>
      )}
    </div>
  )
}

interface DesignDetailProps {
  revision: Revision
  lineage: Revision[]
}

/** Preview-first review of one revision, with its design's other revisions above the preview. */
export function DesignDetail({ revision, lineage }: DesignDetailProps) {
  const open = useDesignsStore((state) => state.open)
  const artifacts = revisionArtifacts(revision)

  return (
    <div className={styles.split} data-testid="sign-detail">
      <div className={styles.left}>
        <div className={styles.lineage}>
          <RevisionRows revisions={lineage} variant="lineage" currentId={revision.id} onOpen={(id) => void open(id)} />
        </div>
        <DesignPreview revision={revision} />
      </div>

      <div className={styles.right}>
        <h1 className={styles.title}>
          r{revision.number} of {revision.title}
        </h1>
        <Axes revision={revision} />
        {artifacts && <ChecksTable artifacts={artifacts} />}
        <Materials revision={revision} artifacts={artifacts} />
        {artifacts && <Hashes artifacts={artifacts} />}
        {/* Keyed so the export path and print note never carry over to another revision. */}
        <Actions key={revision.id} revision={revision} />
      </div>
    </div>
  )
}

export default DesignDetail
