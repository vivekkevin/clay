import { useEffect, useRef } from 'react'
import { Terminal } from 'lucide-react'

export default function JobLog({ logs, compact }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const typeColor = {
    log: 'var(--green)',
    progress: 'var(--blue)',
    error: 'var(--red)',
    complete: 'var(--green)',
    warning: 'var(--orange)',
  }

  if (compact) {
    return (
      <div style={{ padding: '8px 12px', maxHeight: 80, overflowY: 'auto' }}>
        {logs.slice(-3).map((entry, i) => (
          <div key={i} style={{ fontSize: 10, color: typeColor[entry.type] || 'var(--green)', fontFamily: 'var(--mono)', lineHeight: 1.6 }}>
            › {entry.msg}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        padding: '10px 16px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8,
        fontSize: 11, color: 'var(--text3)', flexShrink: 0,
      }}>
        <Terminal size={12} />
        PIPELINE LOG
        <div style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text3)' }}>
          {logs.length} entries
        </div>
      </div>

      <div style={{
        flex: 1, overflowY: 'auto',
        padding: 16,
        background: 'var(--bg)',
        fontFamily: 'var(--code)',
        fontSize: 11,
        lineHeight: 1.8,
      }}>
        {logs.length === 0 ? (
          <div style={{ color: 'var(--text3)', textAlign: 'center', marginTop: 40 }}>
            No log entries yet
          </div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} style={{
              display: 'flex', gap: 12, alignItems: 'flex-start',
              animation: 'fade-in 0.2s ease',
              paddingBottom: 2,
            }}>
              <span style={{ color: 'var(--text3)', fontSize: 10, flexShrink: 0, paddingTop: 1 }}>
                {new Date(entry.ts).toISOString().split('T')[1].slice(0, 8)}
              </span>
              <span style={{ color: 'var(--text3)' }}>›</span>
              <span style={{
                color: typeColor[entry.type] || 'var(--green)',
                wordBreak: 'break-all',
              }}>
                {entry.msg}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
