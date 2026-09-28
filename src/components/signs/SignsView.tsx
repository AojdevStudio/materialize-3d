import { pickFile } from '../../lib/fileDialog'
import { useEffect, useMemo } from 'react'
import { BUILD_STEPS, errorMessage, useSignsStore } from '../../stores/signs'
import type { LineageId, SignRevision } from '../../types/signs'
import { RevisionRows } from './RevisionRows'
import { SignDetail } from './SignDetail'
import styles from './SignsView.module.css'

/** Newest revision per sign, keeping `sign_list`'s newest-first order. */
function latestPerSign(revisions: SignRevision[]): SignRevision[] {
  const seen = new Set<LineageId>()
  return revisions.filter((revision) => {
    if (seen.has(revision.lineage_id)) return false
    seen.add(revision.lineage_id)
    return true
  })
}

/**
 * "Build from spec file" plus the running build's static step list. With a sign
 * open, the new spec becomes that sign's next revision; otherwise it starts a new sign.
 */
function BuildControl({ lineageId }: { lineageId: LineageId | null }) {
  const running = useSignsStore((state) => state.build.status === 'running')
  const buildFromFile = useSignsStore((state) => state.buildFromFile)

  const onBuild = async () => {
    let path: string | null
    try {
      path = await pickFile({ filters: [{ name: 'Sign spec', extensions: ['json'] }] })
    } catch (error) {
      useSignsStore.setState({ build: { status: 'error', message: errorMessage(error) } })
      return
    }
    if (path !== null) await buildFromFile(path, lineageId)
  }

  return (
    <button type="button" data-testid="btn-build-from-spec" className={styles.btn} disabled={running} onClick={() => void onBuild()}>
      Build from spec file
    </button>
  )
}

/** The line under the header: build progress, the reuse notice, or the build error. */
function BuildLine() {
  const build = useSignsStore((state) => state.build)
  const cancelBuild = useSignsStore((state) => state.cancelBuild)

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
          Identical revision r{build.number} already existed. Opened it.
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

/** The Signs workspace view: recent signs, or one revision under review. */
export function SignsView() {
  const recent = useSignsStore((state) => state.recent)
  const lineage = useSignsStore((state) => state.lineage)
  const selected = useSignsStore((state) => state.selected)
  const selectedId = useSignsStore((state) => state.selectedId)
  const error = useSignsStore((state) => state.error)
  const loadRecent = useSignsStore((state) => state.loadRecent)
  const open = useSignsStore((state) => state.open)
  const close = useSignsStore((state) => state.close)
  const signs = useMemo(() => latestPerSign(recent), [recent])

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
        <BuildControl lineageId={shown?.lineage_id ?? null} />
      </header>
      <BuildLine />

      {shown ? (
        <SignDetail revision={shown} lineage={lineage} />
      ) : (
        <div className={styles.recent}>
          {error && <div className={`${styles.empty} ${styles.bad}`}>{error}</div>}
          {signs.length === 0 ? (
            <div className={styles.empty}>No signs yet. Build one from a spec file.</div>
          ) : (
            <RevisionRows revisions={signs} variant="recent" onOpen={(id) => void open(id)} />
          )}
        </div>
      )}
    </div>
  )
}

export default SignsView
