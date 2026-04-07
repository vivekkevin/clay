import { useState, useEffect, useCallback } from 'react'
import { MapPin, ChevronDown, Play, Upload, Globe } from 'lucide-react'
import { getLocations, getPlatforms, submitJob, createJobSocket, TASK_INFO, PLATFORM_COLORS } from '../utils/api.js'

const TASKS = ['inference', 'embeddings', 'landcover', 'cloudremoval', 'bands']

export default function ControlPanel({ selectedLocation, onLocationSelect, onJobStart, onLog, onResult, activeJob, selectedScene, checkpointPath }) {
  const [locations, setLocations] = useState([])
  const [platforms, setPlatforms] = useState([])
  const [task, setTask] = useState('inference')
  const [platform, setPlatform] = useState('sentinel-2-l2a')
  const [modelSize, setModelSize] = useState('base')
  const [maskRatio, setMaskRatio] = useState(0.75)
  const [cloudFraction, setCloudFraction] = useState(0.4)
  const [epochs, setEpochs] = useState(10)
  const [batchSize, setBatchSize] = useState(4)
  const [lr, setLr] = useState(0.001)
  const [numClasses, setNumClasses] = useState(10)
  const [analysisText, setAnalysisText] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [geojsonFile, setGeojsonFile] = useState(null)
  const [showLocations, setShowLocations] = useState(false)
  const [ckptPath, setCkptPath]           = useState('')

  useEffect(() => {
    getLocations().then(d => setLocations(d.locations || []))
    getPlatforms().then(d => setPlatforms(d.platforms || []))
  }, [])

  // Auto-infer task from text
  useEffect(() => {
    if (!analysisText) return
    const t = analysisText.toLowerCase()
    if (t.includes('cloud') || t.includes('reconstruct')) setTask('cloudremoval')
    else if (t.includes('land cover') || t.includes('classify') || t.includes('vegetation')) setTask('landcover')
    else if (t.includes('embed') || t.includes('similar') || t.includes('change')) setTask('embeddings')
    else if (t.includes('band') || t.includes('spectral')) setTask('bands')
  }, [analysisText])

  const handleSubmit = useCallback(async () => {
    if (!selectedLocation) return
    if (!selectedScene?.id) {
      alert('No scene selected!\n\nPlease:\n1. Click a location on the map\n2. In the PC Explorer panel (left of map), click any scene row to activate it\n3. Then click RUN')
      return
    }
    setIsSubmitting(true)

    const params = {
      // Platform + location
      collection:  selectedScene?.collection || platform,
      platform:    selectedScene?.collection || platform,
      item:        selectedScene?.id || '',
      itemId:      selectedScene?.id || '',
      lat:         selectedLocation.lat,
      lon:         selectedLocation.lon,
      locationName:selectedLocation.name,
      // Model
      model_size:  modelSize,
      modelSize:   modelSize,
      checkpoint:  ckptPath || checkpointPath || '',
      // Task params
      mask_ratio:      parseFloat(maskRatio),
      maskRatio:       parseFloat(maskRatio),
      cloud_fraction:  parseFloat(cloudFraction),
      cloudFraction:   parseFloat(cloudFraction),
      epochs:          parseInt(epochs),
      batch_size:      parseInt(batchSize),
      batchSize:       parseInt(batchSize),
      lr:              parseFloat(lr),
      num_classes:     parseInt(numClasses),
      numClasses:      parseInt(numClasses),
    }

    try {
      const { jobId } = await submitJob(task, params)
      const job = { id: jobId, status: 'running', task, params, created: Date.now() }
      onJobStart(job)

      const ws = createJobSocket(jobId, (msg) => {
        if (msg.type === 'result') {
          onResult(msg.result)
          ws.close()
        } else {
          onLog({ ts: msg.ts || Date.now(), msg: msg.msg, type: msg.type })
        }
      })
    } catch (e) {
      console.error(e)
    } finally {
      setIsSubmitting(false)
    }
  }, [selectedLocation, task, platform, modelSize, maskRatio, cloudFraction, epochs, batchSize, lr, numClasses, onJobStart, onLog, onResult])

  // Use parent-provided checkpoint if available
  const effectiveCkpt = ckptPath || checkpointPath || ''
  const hasRealScene  = !!selectedScene?.id

  const canRun    = !!selectedLocation && !!selectedScene?.id
  const runLabel  = !selectedLocation ? 'SELECT LOCATION FIRST'
                  : !selectedScene?.id ? 'SELECT A SCENE FIRST'
                  : isSubmitting       ? 'RUNNING...'
                  : 'RUN ' + task.toUpperCase()
  const info = TASK_INFO[task]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Panel header */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: 2, marginBottom: 6 }}>ANALYSIS CONFIGURATION</div>
        <textarea
          placeholder="Describe your analysis... (e.g. 'detect land cover', 'remove clouds')"
          value={analysisText}
          onChange={e => setAnalysisText(e.target.value)}
          style={{
            width: '100%', height: 52,
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 3, padding: '8px 10px',
            color: 'var(--text)', fontFamily: 'var(--code)', fontSize: 11,
            resize: 'none', outline: 'none',
            lineHeight: 1.5,
          }}
        />
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* Active PC Scene indicator */}
        {hasRealScene && (
          <div style={{ padding:'8px 10px', background:'rgba(41,121,255,0.08)', border:'1px solid rgba(41,121,255,0.3)', borderRadius:4 }}>
            <div style={{ fontFamily:'var(--mono)', fontSize:8, color:'#82b1ff', letterSpacing:2, marginBottom:4 }}>ACTIVE SCENE</div>
            <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginBottom:2 }}>{selectedScene.id}</div>
            <div style={{ display:'flex', gap:12, fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)' }}>
              <span>📡 {selectedScene.collection}</span>
              {selectedScene.cloud != null && <span>☁ {selectedScene.cloud.toFixed(1)}%</span>}
            </div>
          </div>
        )}

        {!hasRealScene && selectedLocation && (
          <div style={{ padding:'7px 10px', background:'rgba(255,145,0,0.07)', border:'1px solid rgba(255,145,0,0.25)', borderRadius:4, fontFamily:'var(--mono)', fontSize:9, color:'#ffaa00', lineHeight:1.6 }}>
            ⚠ No scene selected — select a scene in the PC Explorer panel to use real satellite data. Processing will use synthetic demo data.
          </div>
        )}

        {/* Checkpoint path */}
        <div>
          <div style={{ fontFamily:'var(--mono)', fontSize:8, color:'var(--text3)', letterSpacing:2, marginBottom:5 }}>CLAY CHECKPOINT (.ckpt / .pt)</div>
          <input
            type="text"
            placeholder="./checkpoints/clay-v1.5.ckpt"
            value={ckptPath}
            onChange={e => setCkptPath(e.target.value)}
            style={{ width:'100%', padding:'6px 9px', background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:3, color:'var(--text)', fontFamily:'var(--mono)', fontSize:10, outline:'none', boxSizing:'border-box' }}
          />
          <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)', marginTop:3 }}>
            Leave empty to use demo mode (no model output)
          </div>
        </div>

        {/* Location selector */}
        <Section label="① LOCATION">
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowLocations(!showLocations)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 10px',
                background: selectedLocation ? 'rgba(0, 255, 136, 0.06)' : 'var(--surface2)',
                border: `1px solid ${selectedLocation ? 'rgba(0, 255, 136, 0.25)' : 'var(--border)'}`,
                borderRadius: 3, cursor: 'pointer', color: 'var(--text)',
                fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'left',
              }}
            >
              <MapPin size={11} color={selectedLocation ? 'var(--green)' : 'var(--text3)'} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedLocation ? selectedLocation.name : 'Select location or click map'}
              </span>
              <ChevronDown size={11} color="var(--text3)" />
            </button>

            {showLocations && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 3, maxHeight: 260, overflowY: 'auto',
                boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
                marginTop: 2,
              }}>
                {locations.map(loc => (
                  <button
                    key={loc.id}
                    onClick={() => { onLocationSelect(loc); setShowLocations(false) }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                      padding: '9px 12px', background: 'transparent',
                      border: 'none', borderBottom: '1px solid var(--border)',
                      cursor: 'pointer', textAlign: 'left',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--surface3)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                      background: PLATFORM_COLORS[loc.platform] || 'var(--green)',
                    }} />
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text)', fontFamily: 'var(--mono)' }}>{loc.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>{loc.lat.toFixed(2)}°, {loc.lon.toFixed(2)}° · {loc.platform.split('-')[0]}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedLocation && (
            <div style={{
              padding: '8px 10px', marginTop: 6,
              background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 3,
              fontSize: 10, color: 'var(--text2)', lineHeight: 1.6,
            }}>
              <div style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
                <span style={{ color: 'var(--text3)' }}>LAT</span>
                <span style={{ color: 'var(--green)' }}>{selectedLocation.lat}°</span>
                <span style={{ color: 'var(--text3)' }}>LON</span>
                <span style={{ color: 'var(--green)' }}>{selectedLocation.lon}°</span>
              </div>
              <div style={{ color: 'var(--text3)', fontSize: 10 }}>{selectedLocation.description}</div>
            </div>
          )}
        </Section>

        {/* Task selector */}
        <Section label="② TASK">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {TASKS.map(t => {
              const ti = TASK_INFO[t]
              const isActive = task === t
              return (
                <button
                  key={t}
                  onClick={() => setTask(t)}
                  style={{
                    padding: '8px 10px', textAlign: 'left',
                    background: isActive ? `rgba(${hexToRgb(ti.color)}, 0.1)` : 'var(--surface2)',
                    border: `1px solid ${isActive ? ti.color + '44' : 'var(--border)'}`,
                    borderRadius: 3, cursor: 'pointer',
                    transition: 'all 0.15s',
                  }}
                >
                  <div style={{ fontSize: 14, marginBottom: 2 }}>{ti.icon}</div>
                  <div style={{ fontSize: 10, color: isActive ? ti.color : 'var(--text2)', fontFamily: 'var(--mono)', fontWeight: isActive ? '700' : '400' }}>
                    {ti.label}
                  </div>
                </button>
              )
            })}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 6, lineHeight: 1.5, fontFamily: 'var(--code)' }}>
            {info.description}
          </div>
        </Section>

        {/* Model config */}
        <Section label="③ MODEL">
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Label>Size</Label>
              <Select value={modelSize} onChange={e => setModelSize(e.target.value)}>
                {['tiny', 'small', 'base', 'large'].map(s => <option key={s} value={s}>{s}</option>)}
              </Select>
            </div>
            <div style={{ flex: 2 }}>
              <Label>Platform</Label>
              <Select value={platform} onChange={e => setPlatform(e.target.value)}>
                {platforms.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </div>
          </div>

          {platform && platforms.find(p => p.id === platform) && (
            <div style={{ display: 'flex', gap: 12, marginTop: 6, padding: '6px 10px', background: 'var(--surface2)', borderRadius: 3, border: '1px solid var(--border)' }}>
              {[
                { label: 'BANDS', value: platforms.find(p => p.id === platform)?.bands },
                { label: 'GSD', value: `${platforms.find(p => p.id === platform)?.gsd}m` },
              ].map(({ label, value }) => (
                <div key={label}>
                  <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: 1 }}>{label}</div>
                  <div style={{ fontSize: 13, color: PLATFORM_COLORS[platform], fontFamily: 'var(--mono)' }}>{value}</div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Task-specific options */}
        <Section label="④ OPTIONS" color={info.color}>
          {task === 'inference' && (
            <SliderField label="Mask Ratio" value={maskRatio} onChange={setMaskRatio}
              min={0.1} max={0.9} step={0.05} display={v => `${Math.round(v * 100)}%`} color="var(--blue)" />
          )}

          {task === 'cloudremoval' && (
            <SliderField label="Cloud Fraction" value={cloudFraction} onChange={setCloudFraction}
              min={0.1} max={0.9} step={0.05} display={v => `${Math.round(v * 100)}%`} color="var(--orange)" />
          )}

          {task === 'landcover' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <NumberField label="Epochs" value={epochs} onChange={setEpochs} min={1} max={100} />
                <NumberField label="Batch Size" value={batchSize} onChange={setBatchSize} min={1} max={32} />
                <NumberField label="Classes" value={numClasses} onChange={setNumClasses} min={2} max={10} />
                <div>
                  <Label>Learn Rate</Label>
                  <Input value={lr} onChange={e => setLr(e.target.value)} />
                </div>
              </div>
            </>
          )}

          {task === 'embeddings' && (
            <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--code)', lineHeight: 1.6 }}>
              Extracts 768-dim CLS token + 1024 patch embeddings.<br />
              Runs PCA visualization + similarity search.
            </div>
          )}

          {task === 'bands' && (
            <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--code)', lineHeight: 1.6 }}>
              Displays all {platforms.find(p => p.id === platform)?.bands || '?'} spectral bands<br />
              with p2–p98 contrast stretch.
            </div>
          )}
        </Section>

        {/* GeoJSON AOI */}
        <Section label="⑤ AOI (optional)">
          <label style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 10px',
            background: 'var(--surface2)', border: '1px dashed var(--border)',
            borderRadius: 3, cursor: 'pointer', fontSize: 11, color: 'var(--text3)',
          }}>
            <Upload size={11} />
            {geojsonFile ? geojsonFile.name : 'Upload GeoJSON AOI'}
            <input type="file" accept=".geojson,.json" style={{ display: 'none' }}
              onChange={e => setGeojsonFile(e.target.files[0])} />
          </label>
        </Section>

      </div>

      {/* Run button */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button
          onClick={handleSubmit}
          disabled={!canRun || isSubmitting || activeJob?.status === 'running'}
          style={{
            width: '100%', padding: '12px',
            background: !canRun || isSubmitting || activeJob?.status === 'running'
              ? 'var(--surface2)' : info.color,
            border: `1px solid ${!selectedScene?.id && selectedLocation ? 'rgba(255,145,0,0.5)' : 'transparent'}`,
            borderRadius: 3,
            cursor: !canRun ? 'not-allowed' : 'pointer',
            color: !canRun || isSubmitting ? 'var(--text3)' : '#000',
            fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 12, letterSpacing: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
            transition: 'all 0.2s',
          }}
        >
          {isSubmitting || activeJob?.status === 'running' ? (
            <>
              <div style={{ width: 12, height: 12, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              PROCESSING...
            </>
          ) : (
            <>
              <Play size={13} />
              {runLabel}
            </>
          )}
        </button>

        {/* Status hint below button */}
        {!selectedLocation && (
          <div style={{ textAlign:'center', marginTop:6, fontSize:10, color:'var(--text3)' }}>
            Click map or select a location above
          </div>
        )}
        {selectedLocation && !selectedScene?.id && (
          <div style={{ textAlign:'center', marginTop:6, fontSize:10, color:'#ffaa00', lineHeight:1.5 }}>
            ← Select a scene in the PC Explorer panel first
          </div>
        )}
        {selectedScene?.id && (
          <div style={{ textAlign:'center', marginTop:6, fontSize:9, color:'var(--text3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            Scene: {selectedScene.id}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Helper components ────────────────────────────────────────────────────────

function Section({ label, color, children }) {
  return (
    <div>
      <div style={{
        fontSize: 9, letterSpacing: 2, color: color || 'var(--text3)',
        marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {label}
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      </div>
      {children}
    </div>
  )
}

function Label({ children }) {
  return <div style={{ fontSize: 9, color: 'var(--text3)', letterSpacing: 1, marginBottom: 4 }}>{children}</div>
}

function Select({ value, onChange, children }) {
  return (
    <select
      value={value}
      onChange={onChange}
      style={{
        width: '100%', padding: '6px 8px',
        background: 'var(--surface2)', border: '1px solid var(--border)',
        borderRadius: 3, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11,
        outline: 'none', cursor: 'pointer',
      }}
    >
      {children}
    </select>
  )
}

function Input({ value, onChange }) {
  return (
    <input
      value={value} onChange={onChange}
      style={{
        width: '100%', padding: '6px 8px',
        background: 'var(--surface2)', border: '1px solid var(--border)',
        borderRadius: 3, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11,
        outline: 'none',
      }}
    />
  )
}

function NumberField({ label, value, onChange, min, max }) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type="number" value={value} min={min} max={max}
        onChange={e => onChange(e.target.value)}
        style={{
          width: '100%', padding: '6px 8px',
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 3, color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 11,
          outline: 'none',
        }}
      />
    </div>
  )
}

function SliderField({ label, value, onChange, min, max, step, display, color }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <Label>{label}</Label>
        <span style={{ fontSize: 12, color: color || 'var(--green)', fontFamily: 'var(--mono)' }}>
          {display ? display(value) : value}
        </span>
      </div>
      <input
        type="range" value={value} min={min} max={max} step={step}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: color || 'var(--green)' }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text3)', marginTop: 2 }}>
        <span>{display ? display(min) : min}</span>
        <span>{display ? display(max) : max}</span>
      </div>
    </div>
  )
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r}, ${g}, ${b}`
}