import type { Project, ProjectStatus } from '../../sidecar/src/protocol'

export type Group = 'working' | 'ready' | 'printed' | 'drafts'

/** The groups in the order the sidebar shows them. */
export const GROUPS: readonly Group[] = ['working', 'ready', 'printed', 'drafts']

/**
 * The group a project belongs to. A running turn wins. A project the person marked printed stays printed. A project
 * with a print file is ready. Everything else, including a project whose status has not come yet, is a draft.
 */
export function groupOf(status: ProjectStatus | undefined): Group {
  if (status === undefined) return 'drafts'
  if (status.running) return 'working'
  if (status.printed) return 'printed'
  if (status.printFiles > 0) return 'ready'
  return 'drafts'
}

/** A project's last activity: from its status, or when it was made while its status has not come. */
export const lastActivity = (project: Project, status: ProjectStatus | undefined) => status?.lastMs ?? project.createdMs

/** The groups that hold projects, in sidebar order, each newest first. */
export function groupProjects(projects: Project[], status: Record<string, ProjectStatus>): { group: Group; projects: Project[] }[] {
  return GROUPS.map((group) => ({
    group,
    projects: projects
      .filter((p) => groupOf(status[p.id]) === group)
      .sort((a, b) => lastActivity(b, status[b.id]) - lastActivity(a, status[a.id])),
  })).filter(({ projects }) => projects.length > 0)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** How long ago, as the sidebar shows it: "now", "2m", "1h", "3d", then a short date like "Oct 30". */
export function ago(ms: number, now: number): string {
  const elapsed = now - ms
  if (elapsed < MINUTE) return 'now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`
  const date = new Date(ms)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** The row's second line: what a working project does, or how many print files it has. Drafts, and projects with no print file, have none. */
export function detail(group: Group, status: ProjectStatus | undefined): string | undefined {
  if (group === 'working') return 'Building parts'
  if (group === 'drafts' || status === undefined || status.printFiles === 0) return undefined
  return status.printFiles === 1 ? '1 print file' : `${status.printFiles} print files`
}
