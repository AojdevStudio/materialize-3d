import { useCallback, useEffect, useMemo, useState, type FC } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  AssistantRuntimeProvider,
  AuiConfig,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  Tools,
  defineToolkit,
  useAuiState,
  useLocalRuntime,
  type AssistantState,
  type TextMessagePartComponent,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import type { HistoryEntry } from '../types/agent'
import { PROVIDER_LABELS, modelLabel, useAgentStore } from '../stores/agent'
import { useUiStore } from '../stores/ui'
import { BUILD_STEPS, createAgentAdapter, historyToMessages, type ToolArtifact } from './chat/agentAdapter'
import { BuildTool, ToolLine } from './chat/ToolCalls'
import styles from './chat/ChatPanel.module.css'

// Render-only UIs for tools that run in Rust; keys are the Rust tool names.
// Calls under names the app no longer has render through the Fallback line.
const toolkit = defineToolkit({
  build: { type: 'backend', render: BuildTool },
  revise: { type: 'backend', render: BuildTool },
  list: { type: 'backend', render: ToolLine },
  get: { type: 'backend', render: ToolLine },
  show: { type: 'backend', render: ToolLine },
  printer_status: { type: 'backend', render: ToolLine },
})

const SUGGESTIONS = ['Design a door sign', 'Check printer status', 'List my recent signs'] as const

interface Session {
  conversationId: string
  initialMessages: readonly ThreadMessageLike[]
}

/**
 * The right-column chat with the Rust agent. Rust owns the conversation: the
 * panel loads it once with agent_history and remounts the thread (keyed by
 * conversation id) when a new conversation starts.
 */
export function ChatPanel() {
  const [session, setSession] = useState<Session | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    useAgentStore
      .getState()
      .refresh()
      .catch((err: unknown) => console.error('agent:status failed', err))
    invoke<{ conversationId: string; entries: HistoryEntry[] }>('agent_history')
      .then(({ conversationId, entries }) => {
        if (!cancelled) setSession({ conversationId, initialMessages: historyToMessages(entries) })
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const newConversation = useCallback(async () => {
    const { conversationId } = await invoke<{ conversationId: string }>('agent_new_conversation')
    setSession({ conversationId, initialMessages: [] })
  }, [])

  return (
    <aside className={`chat-panel ${styles.panel}`} aria-label="AI assistant panel" data-testid="chat-panel">
      {session ? (
        <ChatThread key={session.conversationId} session={session} onNewConversation={newConversation} />
      ) : (
        <>
          <Header />
          {loadError && (
            <div className={styles.loadError} data-testid="chat-error">
              Could not load the conversation: {loadError}
            </div>
          )}
        </>
      )}
    </aside>
  )
}

function Header({ onNewConversation, disabled }: { onNewConversation?: () => void; disabled?: boolean }) {
  return (
    <div className={styles.header}>
      <h2 className={styles.title}>AI Assistant</h2>
      {onNewConversation && (
        <button
          type="button"
          className={styles.linkButton}
          onClick={onNewConversation}
          disabled={disabled}
          data-testid="chat-new-conversation"
        >
          New conversation
        </button>
      )}
    </div>
  )
}

function ChatThread({ session, onNewConversation }: { session: Session; onNewConversation: () => Promise<void> }) {
  const adapter = useMemo(() => createAgentAdapter(session.conversationId), [session.conversationId])
  const runtime = useLocalRuntime(adapter, { initialMessages: session.initialMessages })
  const config = AuiConfig({ tools: Tools({ toolkit }) })

  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <ThreadHeader onNewConversation={onNewConversation} />
      <ThreadPrimitive.Root className={styles.thread}>
        <ThreadPrimitive.Viewport className={styles.viewport}>
          <ThreadPrimitive.Empty>
            <div className={styles.welcome}>
              <div>No messages yet. Ask for a part, a sign, or a printer action.</div>
              <div className={styles.suggestions}>
                {SUGGESTIONS.map((prompt) => (
                  <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send className={styles.suggestion}>
                    {prompt}
                  </ThreadPrimitive.Suggestion>
                ))}
              </div>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === 'user' ? <UserMessage /> : <AssistantMessage />)}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <StatusLine />
        <Composer />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

function ThreadHeader({ onNewConversation }: { onNewConversation: () => Promise<void> }) {
  const running = useAuiState((s) => s.thread.isRunning)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <Header
        disabled={running}
        onNewConversation={() =>
          void onNewConversation().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
        }
      />
      {error && (
        <div className={styles.loadError} data-testid="chat-error">
          Could not start a new conversation: {error}
        </div>
      )}
    </>
  )
}

const Text: TextMessagePartComponent = ({ text }) => <div className={styles.text}>{text}</div>

function UserMessage() {
  return (
    <MessagePrimitive.Root className={styles.message}>
      <div className={styles.role}>You</div>
      <MessagePrimitive.Parts components={{ Text }} />
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className={styles.message}>
      <div className={styles.role}>Assistant</div>
      <MessagePrimitive.Parts components={{ Text, tools: { Fallback: ToolLine } }} />
      <TurnError />
    </MessagePrimitive.Root>
  )
}

/** Reads the `{ code, message }` stored on an errored message; anything else becomes a generic error. */
function readTurnError(error: unknown): { code: string; message: string } {
  const fields = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  return {
    code: typeof fields.code === 'string' ? fields.code : 'unknown',
    message: typeof fields.message === 'string' ? fields.message : 'The assistant stopped with an error.',
  }
}

/** The error that ended a turn; a missing key links to Settings. */
const TurnError: FC = () => {
  const error = useAuiState((s) => (s.message.status?.type === 'incomplete' ? s.message.status.error : undefined))
  const openSettings = useUiStore((s) => s.setSettingsOpen)
  if (error === undefined) return null
  const { code, message } = readTurnError(error)
  return (
    <div data-testid="chat-error">
      <div className={styles.bad}>{message}</div>
      {code === 'missingApiKey' && (
        <div>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              openSettings(true)
            }}
          >
            Open Settings
          </a>{' '}
          to add a key, then retry.
        </div>
      )}
    </div>
  )
}

/** What the running turn is doing, as one short phrase. */
function activity(thread: AssistantState['thread']): string {
  if (!thread.isRunning) return 'idle'
  const last = thread.messages[thread.messages.length - 1]
  const pending = last?.content
    .filter((part) => part.type === 'tool-call' && part.result === undefined)
    .pop()
  if (pending?.type !== 'tool-call') return 'responding'
  if (pending.toolName !== 'build') return `running ${pending.toolName}`
  const done = (pending.artifact as ToolArtifact | undefined)?.steps.length ?? 0
  return `build, step ${Math.min(done + 1, BUILD_STEPS.length)} of ${BUILD_STEPS.length}`
}

function StatusLine() {
  const status = useAgentStore((s) => s.status)
  const running = useAuiState((s) => s.thread.isRunning)
  const doing = useAuiState((s) => activity(s.thread))
  return (
    <div className={styles.statusLine}>
      {status && (
        <span className={styles.muted}>
          {PROVIDER_LABELS[status.provider]} · {modelLabel(status.model)}
        </span>
      )}
      <span className={running ? undefined : styles.dim}>
        {doing}
        {!running && status && !status.hasApiKey ? ', no API key' : ''}
      </span>
      {running && (
        <ComposerPrimitive.Cancel className={styles.stop} data-testid="chat-stop">
          Stop
        </ComposerPrimitive.Cancel>
      )}
    </div>
  )
}

function Composer() {
  const empty = useAuiState((s) => s.thread.isEmpty)
  return (
    <ComposerPrimitive.Root className={styles.composer}>
      <ComposerPrimitive.Input
        className={styles.input}
        placeholder={empty ? 'Describe what to make' : 'Reply'}
        data-testid="chat-input"
      />
      <div className={styles.composerRow}>
        <ComposerPrimitive.Send className={styles.send} data-testid="chat-send">
          Send
        </ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  )
}

export default ChatPanel
