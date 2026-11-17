/**
 * The app's own entry kinds in a project's conversation, beside Pi's. Each keeps in `data` what its chat line shows, and
 * `transcript.ts` reads them back by these same tokens.
 */
import { defineEntry } from '@earendil-works/pi-durable'
import type { ChatEntry, ImportedEntry } from './protocol'

/** A person's message as its chat line shows it. */
export type SentMessage = Omit<Extract<ChatEntry, { kind: 'user' }>, 'id' | 'kind'>

/**
 * A person's message, written with its input by a send. Entries are never rewritten, so a message from before files
 * could be attached still has no `files`.
 */
export const UserMessage = defineEntry<Omit<SentMessage, 'files'> & { files?: string[] }>('m3d.user')

/** A line of a chat from before the store, written once by the import. */
export const Imported = defineEntry<ImportedEntry>('m3d.imported')
