import { useState } from 'react'
import { useDesignsStore } from '../../stores/designs'
import { revisionArtifacts, type PartRevision, type RecordedCheck, type Revision, type RevisionId } from '../../types/designs'
import { ApprovedActions, ChecksTable, useBusy, usePreview } from './DesignDetail'
import { approvalWord, buildWord, printAxis, shortHash, type StateWord } from './designFormat'
import { partBlockedReason, requirementRows } from './partFormat'
import styles from './DesignsView.module.css'

function Word({ word }: { word: StateWord }) {
  return <span className={styles[word.tone]}>{word.text}</span>
}

/** A build's warnings: its failed advisory checks, which approving acknowledges. */
function warningsOf(revision: Revision): RecordedCheck[] {
  return revision.build.status === 'verified' ? revision.build.artifacts.checks.filter((check) => check.advisory && !check.passed) : []
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

/** The design's revisions as one row of buttons, the open one marked. */
function RevisionStrip({ lineage, currentId, onOpen }: { lineage: Revision[]; currentId: RevisionId; onOpen: (id: RevisionId) => void }) {
  return (
    <div className={styles.strip} data-testid="part-revisions">
      {lineage.map((revision) => {
        const warnings = warningsOf(revision).length
        return (
          <button
            key={revision.id}
            type="button"
            className={`${styles.stripItem}${revision.id === currentId ? ` ${styles.stripCurrent}` : ''}`}
            aria-current={revision.id === currentId ? 'true' : undefined}
            onClick={() => onOpen(revision.id)}
          >
            <span className={styles.mono}>r{revision.number}</span>
            <Word word={buildWord(revision.build)} />
            {revision.approval.status !== 'pending' && <Word word={approvalWord(revision.approval)} />}
            {warnings > 0 && <span className={styles.warn}>{plural(warnings, 'warning')}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** The kind's isometric render (`design_preview` serves a part's first view). */
function PartRender({ revision }: { revision: PartRevision }) {
  const hasView = revisionArtifacts(revision) !== null
  const preview = usePreview(revision.id, hasView)
  if (!hasView) return <div className={`${styles.renderEmpty} ${styles.muted}`}>No view: this build made no model.</div>

  return (
    <div className={styles.render}>
      {preview.status === 'ready' ? (
        <img data-testid="part-render" className={styles.renderImg} src={preview.url} alt={`Isometric view of r${revision.number}`} />
      ) : preview.status === 'error' ? (
        <span className={styles.bad}>{preview.message}</span>
      ) : null}
    </div>
  )
}

function Requirements({ revision }: { revision: PartRevision }) {
  const checks = revisionArtifacts(revision)?.checks ?? []
  const rows = requirementRows(revision.spec.requirements, checks)
  if (rows.length === 0) return <p className={styles.muted}>No requirements in this spec.</p>

  return (
    <table className={`${styles.table} ${styles.requirements}`} data-testid="part-requirements">
      <thead>
        <tr>
          <th>Requirement</th>
          <th>Target, mm</th>
          <th>Measured</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.index} title={row.detail}>
            <td>
              {row.name} <span className={styles.muted}>{row.kind}</span>
            </td>
            <td className={styles.mono}>{row.target}</td>
            <td className={`${styles.mono}${row.passed === false ? ` ${styles.bad}` : ''}`}>{row.measured ?? (row.passed === false ? row.detail : 'Not measured')}</td>
            <td className={row.passed === null ? styles.muted : row.passed ? styles.ok : styles.bad}>
              {row.passed === null ? 'Not run' : row.passed ? 'Pass' : 'Fail'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Blocking checks passed, then warnings: the count line under the requirements. */
function CheckSummary({ revision }: { revision: PartRevision }) {
  const [open, setOpen] = useState(false)
  const artifacts = revisionArtifacts(revision)
  const print = printAxis(revision)
  if (!artifacts) return null
  const blocking = artifacts.checks.filter((check) => !check.advisory)
  const warnings = warningsOf(revision).length

  return (
    <>
      <p className={styles.summary}>
        <span className={styles.muted}>
          {blocking.filter((check) => check.passed).length} of {blocking.length} checks passed
          {warnings > 0 ? `, ${plural(warnings, 'warning')}` : ''}. Print-tested: {print.word.text.toLowerCase()}, {print.note}.
        </span>{' '}
        <button type="button" className={styles.textLink} onClick={() => setOpen(!open)}>
          {open ? 'Hide checks' : 'Show all checks'}
        </button>
      </p>
      {open && <ChecksTable artifacts={artifacts} />}
    </>
  )
}

/**
 * The decision: why a revision cannot be approved, or its warnings then
 * Approve, or export once approved. Approve sends exactly the warnings listed
 * above it, from the same list.
 */
function Decision({ revision }: { revision: PartRevision }) {
  const approve = useDesignsStore((state) => state.approve)
  const error = useDesignsStore((state) => state.error)
  const { busy, run } = useBusy()
  const { build, approval, number } = revision
  const warnings = warningsOf(revision)

  const body = (() => {
    if (approval.status === 'void') {
      return (
        <div>
          <span className={styles.bad}>Approval void</span> <span className={styles.muted}>{approval.reason}</span>
        </div>
      )
    }
    if (approval.status === 'approved') {
      const acknowledged = approval.acknowledged_warnings.length
      return (
        <>
          <div className={styles.actionRow}>
            <span className={styles.ok}>Approved r{number}</span>
            <span className={styles.muted}>
              for <code className={styles.mono}>{shortHash(approval.package_sha256)}</code>
              {acknowledged > 0 ? `, with ${plural(acknowledged, 'warning')} acknowledged` : ''}
            </span>
          </div>
          <ApprovedActions revision={revision} />
        </>
      )
    }
    if (build.status !== 'verified') {
      const lead = build.status === 'building' ? `r${number} is still building` : `r${number} did not verify: ${partBlockedReason(revision)}`
      return (
        <>
          <div className={build.status === 'building' ? styles.muted : styles.bad} data-testid="part-blocked">
            {lead}.
          </div>
          {build.status !== 'building' && <div className={styles.muted}>Nothing to approve. Ask the agent in chat for a new revision.</div>}
        </>
      )
    }
    const hash = build.artifacts.package_sha256
    return (
      <>
        {warnings.length > 0 && (
          <>
            <div className={styles.warn}>{plural(warnings.length, 'print warning')}</div>
            <ul className={styles.warnings} data-testid="part-warnings">
              {warnings.map((warning) => (
                <li key={warning.id} data-check={warning.id}>
                  {warning.detail}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className={styles.actionRow}>
          <button
            type="button"
            data-testid="btn-approve"
            className={`${styles.btn} ${styles.primary} ${styles.large}`}
            disabled={busy}
            onClick={() => void run(() => approve(revision.id, hash, warnings.map((warning) => warning.id)))}
          >
            Approve r{number}
            {warnings.length > 0 ? ` with ${plural(warnings.length, 'warning')}` : ''} for {shortHash(hash)}
          </button>
          <span className={styles.muted}>Only you can approve. The agent cannot.</span>
        </div>
      </>
    )
  })()

  return (
    <div className={styles.decision}>
      {body}
      {error && (
        <div className={styles.bad} data-testid="part-action-error">
          {error}
        </div>
      )}
    </div>
  )
}

interface PartDetailProps {
  revision: PartRevision
  lineage: Revision[]
}

/**
 * Review of one part revision: its rendered view across the top, the
 * revisions as a strip above it, then the requirements and the decision.
 */
export function PartDetail({ revision, lineage }: PartDetailProps) {
  const open = useDesignsStore((state) => state.open)

  return (
    <div className={styles.partView} data-testid="part-detail">
      <RevisionStrip lineage={lineage} currentId={revision.id} onOpen={(id) => void open(id)} />
      <div className={styles.partBody}>
        <PartRender revision={revision} />
        <div className={styles.partLower}>
          <div className={styles.partColumn}>
            <h2 className={styles.title}>
              r{revision.number} of {revision.title}
            </h2>
            <Requirements revision={revision} />
            <CheckSummary revision={revision} />
          </div>
          <div className={styles.partColumn}>
            <h3 className={styles.sectionTitle}>Decision</h3>
            {/* Keyed so the export path and print note never carry over to another revision. */}
            <Decision key={revision.id} revision={revision} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default PartDetail
