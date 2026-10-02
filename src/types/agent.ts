// Mirrors src-tauri/src/agent/protocol.rs; change both together. `BuildStep`
// is generated from Rust (./generated.ts).

import type { BuildStep } from './generated'

export type { BuildStep }

export type AgentErrorKind = 'missingApiKey' | 'provider' | 'internal'

export type AgentEvent =
  | { type: 'turnStarted'; conversationId: string; turnId: string }
  | { type: 'textDelta'; text: string }
  | { type: 'toolCall'; callId: string; name: string; args: unknown }
  | { type: 'toolProgress'; callId: string; step: BuildStep }
  | { type: 'toolResult'; callId: string; ok: boolean; output: unknown }
  | { type: 'turnFinished' }
  | { type: 'turnCancelled' }
  | { type: 'error'; kind: AgentErrorKind; message: string }

export type Provider = 'anthropic' | 'openai'

export interface AgentStatus {
  provider: Provider
  model: string
  hasApiKey: boolean
}

export type ToolCallStatus = 'started' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type HistoryEntry =
  | { role: 'user'; id: string; text: string; createdAt: string }
  | { role: 'assistant'; id: string; text: string; createdAt: string }
  | {
      role: 'tool'
      callId: string
      name: string
      args: unknown
      status: ToolCallStatus
      output: unknown | null
      createdAt: string
    }
