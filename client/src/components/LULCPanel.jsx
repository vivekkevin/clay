import { useState, useEffect, useRef } from 'react'
import { parseAOI } from '../utils/api.js'

const CLASSES = {
  1: { name: 'Water',          color: '#1565c0' },
  2: { name: 'Dense Veg',      color: '#1b5e20' },
  3: { name: 'Vegetation',     color: '#43a047' },
  4: { name: 'Impervious',     color: '#c62828' },
  5: { name: 'Barren',         color: '#8d6e63' },
  6: { name: 'Wetland/Scrub',  color: '#6a1b9a' },
}

const ALL_YEARS = [2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025]
const DEFAULT_SELECTED = new Set([2015,2018,2021,2024])

const TASKS = [
  { id: 'lulc',        icon: '🗺', name: 'LULC Classification', desc: 'RF + HistGBT · 6 classes' },
  { id: 'embeddings',  icon: '⚡', name: 'Clay Embeddings',      desc: '768-dim CLS + patches'  },
  { id: 'cloudremoval',icon: '☁', name: 'Cloud Removal',        desc: 'MAE reconstruction'      },
  { id: 'change',      icon: '⏱', name: 'Change Detection',     desc: 'Multi-year temporal'     },
]

const PLATFORMS = [
  { id: 'sentinel2', name: 'Sentinel-2 L2A', bands: '10 bands · 10m' },
  { id: 'landsat8',  name: 'Landsat 8/9',   bands: '6 bands · 30m'  },
]

const PIPELINE_STEPS = [
  { label: 'Loading Clay v1.5 model...',              phase: 'model'    },
  { label: 'Checking clay-v1.5.ckpt / .pt...',        phase: 'model'    },
  { label: 'Searching Planetary Computer...',          phase: 'download' },
  { label: 'Downloading satellite bands...',           phase: 'download' },
  { label: 'Applying cloud removal filter...',         phase: 'download' },
  { label: 'Computing 10 spectral indices...',         phase: 'indices'  },
  { label: 'Generating training labels...',            phase: 'indices'  },
  { label: 'Feature engineering — 43 features...',    phase: 'train'    },
  { label: 'Training Random Forest (300 trees)...',   phase: 'train'    },
  { label: 'Training HistGradientBoosting...',        phase: 'train'    },
  { label: 'Meta-learner (Logistic Regression)...',   phase: 'train'    },
  { label: 'Predicting LULC + smoothing...',          phase: 'predict'  },
  { label: 'Evaluating — IoU, F1, Accuracy...',       phase: 'predict'  },
  { label: 'Exporting GeoTIFFs (georeferenced)...',   phase: 'export'   },
  { label: 'Generating 9-panel analysis map...',      phase: 'export'   },
]

function Divider({ label }) {
  return (
    <div style={{ padding: '10px 14px 4px' }}>
      <div style={{ fontSize: 9, letterSpacing: 2.5, color: 'var(--text3)', fontFamily: 'var(--mono)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ height: 1, background: 'var(--border)', marginTop: 5 }} />
    </div>
  )
}

export default function LULCPanel({ onStateChange }) {
  const [aoi, setAoi]                   = useState(null)
  const [aoiName, setAoiName]           = useState('')
  const [selectedYears, setSelectedYears] = useState(DEFAULT_SELECTED)
  const [platform, setPlatform]         = useState('sentinel2')
  const [task, setTask]                 = useState('lulc')
  const [cloudPct, setCloudPct]         = useState(20)
  const [running, setRunning]           = useState(false)
  const [logs, setLogs]                 = useState([{ ts: '00:00', msg: 'Clay·LULC ready. Upload a GeoJSON to begin.', type: 'info' }])
  const [progress, setProgress]         = useState(0)
  const [results, setResults]           = useState(null)
  const [activeLayer, setActiveLayer]   = useState('satellite')
  const [overlayOpacity, setOverlayOpacity] = useState(70)
  // ── NEW: live processing state ──────────────────────────────
  const [currentStep, setCurrentStep]   = useState('')
  const [currentYear, setCurrentYear]   = useState(null)
  const [currentPhase, setCurrentPhase] = useState('')
  const [stepIndex, setStepIndex]       = useState(0)
  const [yearIndex, setYearIndex]       = useState(0)
  // ────────────────────────────────────────────────────────────
  const fileRef = useRef()
  const logRef  = useRef()

  const addLog = (msg, type = '') => {
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setLogs(prev => [...prev, { ts, msg, type }])
    setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, 50)
  }

  const toggleYear = (yr) => {
    setSelectedYears(prev => {
      const next = new Set(prev)
      if (next.has(yr)) { if (next.size > 1) next.delete(yr) }
      else next.add(yr)
      return next
    })
  }

  const handleGeoJSON = async (file) => {
    if (!file) return
    const text = await file.text()
    try {
      const gj = JSON.parse(text)
      const res = await parseAOI(gj).catch(() => null)
      setAoi(gj)
      setAoiName(file.name)
      addLog(`AOI loaded: ${file.name}`, 'ok')
      if (res?.bbox) addLog(`BBox: [${res.bbox.map(v => v.toFixed(4)).join(', ')}]`, 'info')
    } catch { addLog('Invalid GeoJSON file', 'err') }
  }

  // ── Emit full state (including live processing fields) to LULCMap
  useEffect(() => {
    onStateChange?.({
      aoi, aoiName,
      selectedYears: [...selectedYears],
      platform, task, cloudPct,
      running, results,
      activeLayer, overlayOpacity, logs,
      currentStep,
      currentYear,
      currentPhase,
      stepIndex,
      yearIndex,
      totalYears: selectedYears.size,
      totalSteps: PIPELINE_STEPS.length,
      progress,
    })
  }, [
    aoi, aoiName, selectedYears, platform, task, cloudPct,
    running, results, activeLayer, overlayOpacity, logs,
    currentStep, currentYear, currentPhase, stepIndex, yearIndex, progress,
  ])

  const runPipeline = () => {
    if (running) return
    setRunning(true)
    setProgress(0)
    setResults(null)
    setStepIndex(0)
    setYearIndex(0)

    const years = [...selectedYears].sort((a, b) => a - b)
    let si = 0, yi = 0

    addLog(`▶ Pipeline started: ${years.join(', ')}`, 'info')
    addLog(`Platform: ${platform} | Task: ${task} | Cloud < ${cloudPct}%`, 'info')
    addLog(`── Year ${years[0]} ──`, 'info')

    setCurrentYear(years[0])
    setCurrentStep(PIPELINE_STEPS[0].label)
    setCurrentPhase(PIPELINE_STEPS[0].phase)

    const tick = () => {
      if (si >= PIPELINE_STEPS.length) {
        if (yi < years.length - 1) {
          yi++
          si = 0
          setYearIndex(yi)
          setCurrentYear(years[yi])
          setCurrentStep(PIPELINE_STEPS[0].label)
          setCurrentPhase(PIPELINE_STEPS[0].phase)
          setStepIndex(0)
          addLog(`── Year ${years[yi]} ──`, 'info')
          setTimeout(tick, 300)
          return
        }
        // ── All done ──
        const synth = makeSyntheticResults(years)
        setResults(synth)
        setRunning(false)
        setProgress(100)
        setCurrentStep('')
        setCurrentPhase('')
        setCurrentYear(null)
        addLog(`✅ Pipeline complete! ${years.length} year(s) processed.`, 'ok')
        addLog(`IoU: ${synth.iou.toFixed(4)}  F1: ${synth.f1.toFixed(4)}  Acc: ${synth.acc.toFixed(2)}%`, 'ok')
        return
      }

      const step = PIPELINE_STEPS[si]
      const pct  = Math.floor(((yi * PIPELINE_STEPS.length + si) / (years.length * PIPELINE_STEPS.length)) * 98)

      setProgress(pct)
      setCurrentStep(step.label)
      setCurrentPhase(step.phase)
      setStepIndex(si)
      addLog(step.label)

      si++
      setTimeout(tick, 380 + Math.random() * 270)
    }

    setTimeout(tick, 400)
  }

  const makeSyntheticResults = (years) => {
    const perClass = {}
    Object.keys(CLASSES).forEach(id => {
      perClass[id] = { area: Math.random()*28+3, iou: Math.random()*.4+.55, f1: Math.random()*.35+.60 }
    })
    const total = Object.values(perClass).reduce((s, v) => s + v.area, 0)
    Object.values(perClass).forEach(v => v.area = v.area / total * 100)
    const yearResults = {}
    years.forEach(yr => {
      const base = {}
      Object.keys(CLASSES).forEach(id => { base[id] = Math.random()*28+3 })
      const s = Object.values(base).reduce((a, b) => a + b, 0)
      Object.keys(base).forEach(id => base[id] = base[id] / s * 100)
      yearResults[yr] = base
    })
    return {
      iou: .73 + Math.random()*.15,
      f1:  .76 + Math.random()*.14,
      acc: 84  + Math.random()*10,
      prec:.78 + Math.random()*.12,
      perClass, yearResults, years,
    }
  }

  const logColors = { ok: 'var(--green)', err: 'var(--red)', info: 'var(--blue)', warn: 'var(--orange)', '': 'var(--text2)' }

  const phaseColors = {
    model:    'var(--purple)',
    download: 'var(--blue)',
    indices:  'var(--orange)',
    train:    '#ff6b6b',
    predict:  'var(--green)',
    export:   'var(--text2)',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* AOI */}
        <Divider label="01 · AOI GeoJSON" />
        <div style={{ padding: '0 14px 10px' }}>
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); handleGeoJSON(e.dataTransfer.files[0]) }}
            style={{
              border: `1px dashed ${aoi ? 'var(--green)' : 'var(--border2)'}`,
              borderRadius: 5, padding: '12px 10px', textAlign: 'center',
              cursor: 'pointer', color: aoi ? 'var(--green)' : 'var(--text3)',
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1,
              background: aoi ? 'rgba(0,255,136,.04)' : 'transparent',
              transition: 'all .2s',
            }}
          >
            {aoi ? `✅ ${aoiName}` : '⬆  DROP GEOJSON / CLICK'}
          </div>
          <input ref={fileRef} type="file" accept=".geojson,.json" style={{ display: 'none' }}
            onChange={e => handleGeoJSON(e.target.files[0])} />
        </div>

        {/* Clay Model */}
        <Divider label="02 · Clay Model" />
        <div style={{ padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          {[['clay-v1.5.ckpt','~2.4 GB · ViT','LOCAL'],['clay-v1.5.pt','TorchScript','DETECT']].map(([name,size,status]) => (
            <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: 'rgba(0,150,255,.05)', border: '1px solid rgba(0,150,255,.15)', borderRadius: 4 }}>
              <span style={{ fontSize: 12 }}>🧠</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)' }}>{name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)' }}>{size}</div>
              </div>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 9, padding: '2px 6px', borderRadius: 10, background: status==='LOCAL'?'rgba(0,255,136,.12)':'rgba(255,170,0,.12)', color: status==='LOCAL'?'var(--green)':'var(--orange)', border: `1px solid ${status==='LOCAL'?'rgba(0,255,136,.3)':'rgba(255,170,0,.3)'}` }}>{status}</span>
            </div>
          ))}
        </div>

        {/* Platform */}
        <Divider label="03 · Satellite Platform" />
        <div style={{ padding: '0 14px 10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          {PLATFORMS.map(p => (
            <div key={p.id} onClick={() => setPlatform(p.id)} style={{
              padding: '7px 8px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${platform===p.id ? 'var(--blue)' : 'var(--border)'}`,
              background: platform===p.id ? 'rgba(0,170,255,.07)' : 'var(--surface2)',
              transition: 'all .15s',
            }}>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: platform===p.id ? 'var(--blue)' : 'var(--text)' }}>{p.name}</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', marginTop: 2 }}>{p.bands}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: '0 14px 10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', letterSpacing: 2 }}>CLOUD FILTER</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--blue)' }}>{cloudPct}%</span>
          </div>
          <input type="range" min="5" max="80" value={cloudPct} onChange={e => setCloudPct(+e.target.value)}
            style={{ width: '100%', accentColor: 'var(--blue)' }} />
        </div>

        {/* Years */}
        <Divider label="04 · Analysis Years" />
        <div style={{ padding: '0 14px 10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 3, marginBottom: 8 }}>
            {ALL_YEARS.map(yr => {
              const isProcessing = running && currentYear === yr
              return (
                <div key={yr} onClick={() => !running && toggleYear(yr)} style={{
                  padding: '4px 2px', borderRadius: 3, textAlign: 'center',
                  cursor: running ? 'default' : 'pointer',
                  fontFamily: 'var(--mono)', fontSize: 10,
                  border: `1px solid ${isProcessing ? 'var(--orange)' : selectedYears.has(yr) ? 'var(--blue)' : 'var(--border)'}`,
                  background: isProcessing ? 'rgba(255,170,0,.15)' : selectedYears.has(yr) ? 'rgba(0,170,255,.1)' : 'var(--surface2)',
                  color: isProcessing ? 'var(--orange)' : selectedYears.has(yr) ? 'var(--blue)' : 'var(--text3)',
                  transition: 'all .12s',
                  animation: isProcessing ? 'pulse-green 1s infinite' : 'none',
                }}>{yr}{isProcessing ? ' ◉' : ''}</div>
              )
            })}
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)' }}>
            {[...selectedYears].sort((a,b)=>a-b).join(' · ')} selected
          </div>
        </div>

        {/* Task */}
        <Divider label="05 · Task" />
        <div style={{ padding: '0 14px 10px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {TASKS.map(t => (
            <div key={t.id} onClick={() => setTask(t.id)} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px',
              borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${task===t.id ? 'var(--green)' : 'transparent'}`,
              background: task===t.id ? 'rgba(0,255,136,.05)' : 'var(--surface2)',
              transition: 'all .15s',
            }}>
              <span style={{ fontSize: 13 }}>{t.icon}</span>
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: task===t.id ? 'var(--green)' : 'var(--text)' }}>{t.name}</div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)' }}>{t.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Layer controls */}
        <Divider label="06 · Map Layer" />
        <div style={{ padding: '0 14px 10px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 3 }}>
            {['satellite','lulc','ndvi','confidence','change','error'].map(lyr => (
              <div key={lyr} onClick={() => setActiveLayer(lyr)} style={{
                padding: '5px 4px', borderRadius: 3, textAlign: 'center', cursor: 'pointer',
                fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 1, textTransform: 'uppercase',
                border: `1px solid ${activeLayer===lyr ? 'var(--green)' : 'var(--border)'}`,
                color: activeLayer===lyr ? 'var(--green)' : 'var(--text3)',
                background: activeLayer===lyr ? 'rgba(0,255,136,.06)' : 'transparent',
                transition: 'all .12s',
              }}>{lyr}</div>
            ))}
          </div>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', letterSpacing: 1, flexShrink: 0 }}>OPACITY</span>
            <input type="range" min="0" max="100" value={overlayOpacity}
              onChange={e => setOverlayOpacity(+e.target.value)}
              style={{ flex: 1, accentColor: 'var(--green)' }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--green)', minWidth: 32, textAlign: 'right' }}>{overlayOpacity}%</span>
          </div>
        </div>

        {/* LULC Legend */}
        <Divider label="Classes" />
        <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Object.entries(CLASSES).map(([id, cls]) => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)' }}>
              <div style={{ width: 10, height: 10, borderRadius: 2, background: cls.color, flexShrink: 0 }} />
              {id}. {cls.name}
            </div>
          ))}
        </div>

        {/* Results preview */}
        {results && (
          <>
            <Divider label="Results" />
            <div style={{ padding: '0 14px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
              {[['ACCURACY',results.acc.toFixed(1)+'%'],['IoU',results.iou.toFixed(4)],['F1',results.f1.toFixed(4)],['PRECISION',results.prec.toFixed(4)]].map(([label,val]) => (
                <div key={label} style={{ padding: '7px 9px', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 4 }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--text3)', letterSpacing: 1.5, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 15, color: 'var(--green)', fontWeight: 700 }}>{val}</div>
                </div>
              ))}
            </div>
            <div style={{ padding: '0 14px 12px' }}>
              {Object.entries(results.perClass).map(([id, cls]) => (
                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 1, background: CLASSES[id]?.color, flexShrink: 0 }} />
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', width: 70 }}>{CLASSES[id]?.name}</span>
                  <div style={{ flex: 1, height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: cls.area+'%', background: CLASSES[id]?.color, borderRadius: 2 }} />
                  </div>
                  <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text2)', minWidth: 34, textAlign: 'right' }}>{cls.area.toFixed(1)}%</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Progress bar */}
      {running && (
        <div style={{ flexShrink: 0 }}>
          {/* Phase label */}
          <div style={{ padding: '4px 14px 2px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: phaseColors[currentPhase] || 'var(--text3)', letterSpacing: 1 }}>
              {currentPhase.toUpperCase()}
            </span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)' }}>
              step {stepIndex + 1}/{PIPELINE_STEPS.length}
            </span>
          </div>
          <div style={{ height: 2, background: 'var(--border)' }}>
            <div style={{ height: '100%', width: progress+'%', background: `linear-gradient(90deg, var(--blue), ${phaseColors[currentPhase] || 'var(--green)'})`, transition: 'width .4s ease' }} />
          </div>
        </div>
      )}

      {/* Run button */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        <button onClick={runPipeline} disabled={running} style={{
          width: '100%', padding: '10px', borderRadius: 5,
          background: running ? 'rgba(0,170,255,.07)' : 'rgba(0,170,255,.1)',
          border: `1px solid ${running ? 'var(--blue-dim)' : 'var(--blue)'}`,
          color: running ? 'var(--blue-dim)' : 'var(--blue)',
          fontFamily: 'var(--mono)', fontSize: 12, letterSpacing: 2,
          cursor: running ? 'not-allowed' : 'pointer',
          transition: 'all .2s',
        }}>
          {running ? `⏳ ${currentYear || '...'} — ${progress}%` : '▶  RUN PIPELINE'}
        </button>
      </div>

      {/* Console log */}
      <div style={{ height: 160, borderTop: '1px solid var(--border)', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '6px 14px 3px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 8, color: 'var(--text3)', letterSpacing: 2 }}>CONSOLE LOG</span>
          <button onClick={() => setLogs([])} style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontFamily: 'var(--mono)', fontSize: 8 }}>CLEAR</button>
        </div>
        <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: '0 14px 8px' }}>
          {logs.map((l, i) => (
            <div key={i} style={{ fontFamily: 'var(--mono)', fontSize: 9, color: logColors[l.type] || 'var(--text2)', marginBottom: 2 }}>
              <span style={{ color: 'var(--text3)', marginRight: 6 }}>{l.ts}</span>{l.msg}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
