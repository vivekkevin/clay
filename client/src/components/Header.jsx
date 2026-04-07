import { Layers, Globe, Map } from 'lucide-react'

const MAP_STYLES = ['satellite', 'dark', 'terrain']

export default function Header({ mapStyle, onMapStyleChange, activeView, onViewChange, activeJob, mode, onModeChange }) {
  return (
    <div style={{
      height: 48, background: 'var(--surface)', borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', padding: '0 16px', gap: 12,
      flexShrink: 0, zIndex: 20,
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px var(--green)', animation: 'pulse-green 2s infinite' }} />
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--green)', letterSpacing: 2, fontWeight: 700 }}>CLAY</span>
        <span style={{ color: 'var(--border2)', fontSize: 11 }}>·</span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text2)', letterSpacing: 1 }}>LULC</span>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 2, background: 'var(--surface2)', borderRadius: 4, padding: 2, border: '1px solid var(--border)' }}>
        {[
          { id: 'clay', label: '◈ CLAY MODEL', color: 'var(--blue)' },
          { id: 'lulc', label: '🗺 LULC', color: 'var(--green)' },
        ].map(({ id, label, color }) => (
          <button key={id} onClick={() => onModeChange(id)} style={{
            padding: '4px 12px', borderRadius: 3, border: 'none', cursor: 'pointer',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.5,
            background: mode === id ? color + '18' : 'transparent',
            color: mode === id ? color : 'var(--text3)',
            borderBottom: mode === id ? `2px solid ${color}` : '2px solid transparent',
            transition: 'all .15s',
          }}>{label}</button>
        ))}
      </div>

      {/* Map style (only in clay mode) */}
      {mode === 'clay' && (
        <div style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
          {MAP_STYLES.map(s => (
            <button key={s} onClick={() => onMapStyleChange(s)} style={{
              padding: '3px 10px', borderRadius: 3, border: '1px solid',
              borderColor: mapStyle === s ? 'var(--border2)' : 'transparent',
              background: mapStyle === s ? 'var(--surface2)' : 'transparent',
              color: mapStyle === s ? 'var(--text)' : 'var(--text3)',
              fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1.5, cursor: 'pointer',
              textTransform: 'uppercase', transition: 'all .15s',
            }}>{s}</button>
          ))}
        </div>
      )}

      <div style={{ flex: 1 }} />

      {/* Active job indicator */}
      {activeJob && activeJob.status === 'running' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: 'rgba(255,170,0,0.08)', border: '1px solid rgba(255,170,0,0.3)', borderRadius: 3 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--orange)', animation: 'pulse-green 1s infinite' }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--orange)', letterSpacing: 1 }}>PROCESSING</span>
        </div>
      )}

      <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', letterSpacing: 1 }}>
        Planetary Computer · v1.5
      </div>
    </div>
  )
}
