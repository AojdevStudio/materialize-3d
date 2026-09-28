import { Component, type ReactNode, type ErrorInfo } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Error boundary that catches render errors in child components
 * and shows an error message instead of blanking the entire app.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div style={{
          padding: '24px',
          color: 'var(--text-secondary)',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: '13px',
        }}>
          <div style={{ color: 'var(--accent-red)', marginBottom: '8px', fontWeight: 600 }}>
            Something went wrong
          </div>
          <div style={{ opacity: 0.7 }}>
            {this.state.error?.message ?? 'Unknown error'}
          </div>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: '12px',
              padding: '6px 12px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: '4px',
              color: 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
