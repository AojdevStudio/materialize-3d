import { invoke } from '@tauri-apps/api/core'
import { usePrintHistoryStore, applyHistorySnapshot, type PrintHistoryRecord } from '../stores/printHistory'

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function formatDuration(seconds: number | null): string {
  if (seconds == null || seconds < 0) return '—'
  if (seconds < 60) return '<1m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

export function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString)
    if (isNaN(d.getTime())) return isoString
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return isoString
  }
}

// ─── Delete handler ──────────────────────────────────────────────────────────

async function handleDelete(id: string) {
  try {
    await invoke('delete_print_history_item', { id })
    const records = await invoke<PrintHistoryRecord[]>('get_print_history')
    applyHistorySnapshot(records)
  } catch (error) {
    console.error('failed to delete history item', error)
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

function HistoryStatusBadge({ status, failReason }: { status: string; failReason: string | null }) {
  const isSuccess = status === 'completed'
  const isFailed = status === 'failed'
  const variant = isSuccess ? 'history-status--success' : isFailed ? 'history-status--failed' : ''
  const label = isSuccess ? 'Success' : isFailed ? `Failed${failReason ? `: ${failReason}` : ''}` : status

  return (
    <span className={`history-status ${variant}`} data-testid="history-status">
      {label}
    </span>
  )
}

function HistoryCard({ record }: { record: PrintHistoryRecord }) {
  return (
    <article className="history-card" data-testid="history-card">
      <div className="history-card-header">
        <h3 className="history-card-title">{record.modelName}</h3>
        <HistoryStatusBadge status={record.status} failReason={record.failReason} />
      </div>

      {record.thumbnailPath && (
        <img
          className="history-thumbnail"
          src={record.thumbnailPath}
          alt={`${record.modelName} thumbnail`}
        />
      )}

      <div className="history-meta">
        <span data-testid="history-date">{formatDate(record.completedAt)}</span>
        <span data-testid="history-duration">{formatDuration(record.durationSeconds)}</span>
        {record.filamentGrams != null && (
          <span data-testid="history-filament">
            {record.filamentGrams.toFixed(1)}g
            {record.filamentMeters != null && ` / ${record.filamentMeters.toFixed(1)}m`}
          </span>
        )}
        {record.qualityProfile && (
          <span data-testid="history-quality">{record.qualityProfile}</span>
        )}
      </div>

      <button
        type="button"
        className="history-delete"
        onClick={() => void handleDelete(record.id)}
        aria-label={`Delete ${record.modelName}`}
        data-testid="history-delete"
        title="Delete from history"
      >
        🗑
      </button>
    </article>
  )
}

export function PrintHistory() {
  const records = usePrintHistoryStore((s) => s.records)

  if (records.length === 0) {
    return (
      <div className="print-history" data-testid="print-history">
        <div className="print-history-header">
          <h2 className="print-history-title">Print History</h2>
        </div>
        <div className="print-history-empty" data-testid="print-history-empty">
          <span className="print-history-empty-icon" aria-hidden="true">📷</span>
          <h3 className="print-history-empty-heading">No prints recorded yet</h3>
          <p className="print-history-empty-subtext">
            Print history will appear here as prints complete
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="print-history" data-testid="print-history">
      <div className="print-history-header">
        <h2 className="print-history-title">Print History</h2>
        <span className="print-history-count">{records.length} print{records.length !== 1 ? 's' : ''}</span>
      </div>
      <div className="print-history-list">
        {records.map((record) => (
          <HistoryCard key={record.id} record={record} />
        ))}
      </div>
    </div>
  )
}

export default PrintHistory
