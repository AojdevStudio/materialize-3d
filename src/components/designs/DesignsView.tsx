import { pickFile } from '../../lib/fileDialog'
import { useEffect, useMemo } from 'react'
import { BUILD_STEPS, errorMessage, useDesignsStore } from '../../stores/designs'
import type { Kind, LineageId, Revision } from '../../types/designs'
import { DesignDetail } from './DesignDetail'
import { RevisionRows } from './RevisionRows'
import styles from './DesignsView.module.css'

/** The kind a spec file builds as when no design is open: sign is the only registered kind. */
const DEFAULT_KIND: Kind = 'sign'

/** Newest revision per design, keeping `design_list`'s newest-first order. */
function latestPerDesign(revisions: Revision[]): Revision[] {
  const seen = new Set<LineageId>()
  return revisions.filter((revision) => {
    if (seen.has(revision.lineage_id)) return false
    seen.add(revision.lineage_id)
    return true
  })
}

/**
 * "Build from spec file" plus the running build's static step list. With a design
 * open, the new spec becomes that design's next revision, of its kind; otherwise
 * it starts a new design.
 */
function BuildControl({ open }: { open: Revision | null }) {
  const running = useDesignsStore((state) => state.build.status === 'running')
  const buildFromFile = useDesignsStore((state) => state.buildFromFile)

  const onBuild = async () => {
    let path: string | null
    try {
      path = await pickFile({ filters: [{ name: 'Sign spec', extensions: ['json'] }] })
    } catch (error) {
      useDesignsStore.setState({ build: { status: 'error', message: errorMessage(error) } })
      return
    }
    if (path !== null) await buildFromFile(path, open?.lineage_id ?? null, open?.kind ?? DEFAULT_KIND)
  }

  return (
    <button type="button" data-testid="btn-build-from-spec" className={styles.btn} disabled={running} onClick={() => void onBuild()}>
      Build from spec file
    </button>
  )
}

/** The line under the header: build progress, the reuse notice, or the build error. */
function BuildLine() {
  const build = useDesignsStore((state) => state.build)
  const cancelBuild = useDesignsStore((state) => state.cancelBuild)

  switch (build.status) {
    case 'idle':
      return null
    case 'running':
      return (
        <div className={styles.buildLine}>
          <ol className={styles.steps} data-testid="build-progress">
            {BUILD_STEPS.map(([step, label]) => (
              <li key={step} data-step={step} data-done={build.done.includes(step)} className={build.done.includes(step) ? styles.stepDone : styles.stepPending}>
                {label}
              </li>
            ))}
          </ol>
          <button type="button" data-testid="btn-cancel-build" className={styles.btn} onClick={() => void cancelBuild()}>
            Cancel
          </button>
        </div>
      )
    case 'reused':
      return (
        <div className={styles.buildLine} data-testid="build-reused">
          Nothing to build: r{build.number} uses an identical verified build. Opened it.
        </div>
      )
    case 'error':
      return (
        <div className={`${styles.buildLine} ${styles.bad}`} data-testid="build-error">
          {build.message}
        </div>
      )
  }
}

/** The designs workspace view (shown as Signs): recent designs, or one revision under review. */
export function DesignsView() {
  const recent = useDesignsStore((state) => state.recent)
  const lineage = useDesignsStore((state) => state.lineage)
  const selected = useDesignsStore((state) => state.selected)
  const selectedId = useDesignsStore((state) => state.selectedId)
  const error = useDesignsStore((state) => state.error)
  const loadRecent = useDesignsStore((state) => state.loadRecent)
  const open = useDesignsStore((state) => state.open)
  const close = useDesignsStore((state) => state.close)
  const designs = useMemo(() => latestPerDesign(recent), [recent])

  useEffect(() => {
    void loadRecent()
  }, [loadRecent])

  const shown = selectedId !== null && selected !== null ? selected : null

  return (
    <div className={styles.view} data-testid="signs-view">
      <header className={styles.header}>
        <h1 className={styles.crumbs}>
          {shown ? (
            <>
              <button type="button" className={styles.crumbLink} onClick={close}>
                Signs
              </button>
              <span className={styles.dim}>/</span>
              <span className={styles.ellipsis}>{shown.title}</span>
            </>
          ) : (
            'Signs'
          )}
        </h1>
        <span className={styles.grow} />
        <BuildControl open={shown} />
      </header>
      <BuildLine />

      {shown ? (
        <DesignDetail revision={shown} lineage={lineage} />
      ) : (
        <div className={styles.recent}>
          {error && <div className={`${styles.empty} ${styles.bad}`}>{error}</div>}
          {designs.length === 0 ? (
            <div className={styles.empty}>No signs yet. Build one from a spec file.</div>
          ) : (
            <RevisionRows revisions={designs} variant="recent" onOpen={(id) => void open(id)} />
          )}
        </div>
      )}
    </div>
  )
}

export default DesignsView
