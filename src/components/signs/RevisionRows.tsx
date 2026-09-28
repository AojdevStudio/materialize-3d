import type { CSSProperties } from 'react'
import type { RevisionId, SignRevision } from '../../types/signs'
import { approvalWord, buildWord, formatTime, printWord, type StateWord } from './signFormat'
import styles from './SignsView.module.css'

interface RevisionRowsProps {
  revisions: SignRevision[]
  currentId?: RevisionId | null
  /** `recent` spans signs, so it adds Sign and Created columns; `lineage` fits the narrow preview column. */
  variant: 'recent' | 'lineage'
  onOpen: (id: RevisionId) => void
}

function Word({ word }: { word: StateWord }) {
  return <span className={styles[word.tone]}>{word.text}</span>
}

/** One clickable row per revision: number, then each axis in its own column. */
export function RevisionRows({ revisions, currentId = null, variant, onOpen }: RevisionRowsProps) {
  const recent = variant === 'recent'
  const columns = {
    '--sign-row-columns': recent ? 'minmax(120px, 1fr) 32px 64px 64px 72px 112px' : '32px 64px 64px 1fr',
  } as CSSProperties

  return (
    <div className={styles.rows} style={columns}>
      <div className={styles.rowHead} aria-hidden="true">
        {recent && <span>Sign</span>}
        <span>Rev</span>
        <span>Build</span>
        <span>Approval</span>
        <span>Print</span>
        {recent && <span>Created</span>}
      </div>
      {revisions.map((revision) => (
        <button
          key={revision.id}
          type="button"
          data-testid="sign-revision-row"
          className={`${styles.row}${revision.id === currentId ? ` ${styles.rowCurrent}` : ''}`}
          aria-current={revision.id === currentId ? 'true' : undefined}
          onClick={() => onOpen(revision.id)}
        >
          {recent && <span className={styles.ellipsis}>{revision.title}</span>}
          <span className={styles.mono}>r{revision.number}</span>
          <Word word={buildWord(revision.build)} />
          <Word word={approvalWord(revision.approval)} />
          <Word word={printWord(revision.print_validation)} />
          {recent && <span className={styles.muted}>{formatTime(revision.created_at)}</span>}
        </button>
      ))}
    </div>
  )
}

export default RevisionRows
