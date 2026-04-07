import { useState } from 'react'
import { X, BarChart2, TrendingDown, Layers, Target, AlertTriangle, Info } from 'lucide-react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts'
import { TASK_INFO } from '../utils/api.js'
import JobLog from './JobLog.jsx'

// Biome accent colors
const BIOME_COLORS = {
  desert:   { color: '#ff9100', bg: 'rgba(255,145,0,0.08)',   border: 'rgba(255,145,0,0.3)'   },
  tropical: { color: '#00e676', bg: 'rgba(0,230,118,0.08)',   border: 'rgba(0,230,118,0.3)'   },
  arctic:   { color: '#82b1ff', bg: 'rgba(130,177,255,0.08)', border: 'rgba(130,177,255,0.3)' },
  alpine:   { color: '#b0bec5', bg: 'rgba(176,190,197,0.08)', border: 'rgba(176,190,197,0.3)' },
  savanna:  { color: '#ffd600', bg: 'rgba(255,214,0,0.08)',   border: 'rgba(255,214,0,0.3)'   },
  coastal:  { color: '#00b8d4', bg: 'rgba(0,184,212,0.08)',   border: 'rgba(0,184,212,0.3)'   },
  wetland:  { color: '#40c4ff', bg: 'rgba(64,196,255,0.08)',  border: 'rgba(64,196,255,0.3)'  },
  temperate:{ color: '#00ff88', bg: 'rgba(0,255,136,0.08)',   border: 'rgba(0,255,136,0.3)'   },
}

const BIOME_ICONS = {
  desert:'🏜', tropical:'🌳', arctic:'🧊', alpine:'🏔',
  savanna:'🌾', coastal:'🪸', wetland:'🌿', temperate:'🌿',
}

export default function ResultsPanel({ result, activeJob, logs, onClose }) {
  const [tab, setTab] = useState('metrics')
  const info = result ? TASK_INFO[result.task] : activeJob ? TASK_INFO[activeJob.task] : null

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden', animation:'slide-in-right 0.3s ease' }}>
      {/* Header */}
      <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
        {info && (
          <div style={{ width:28, height:28, display:'flex', alignItems:'center', justifyContent:'center', background:`${info.color}18`, border:`1px solid ${info.color}44`, borderRadius:4, fontSize:14, flexShrink:0 }}>
            {info.icon}
          </div>
        )}
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:12, color:'var(--text)', fontFamily:'var(--mono)', fontWeight:700 }}>{info?.label || 'Analysis'}</div>
          <div style={{ fontSize:10, color:'var(--text3)' }}>
            {result
              ? `${result.platform} · ${result.lat?.toFixed(3)}°, ${result.lon?.toFixed(3)}°`
              : activeJob?.status === 'running' ? 'Processing...' : ''}
          </div>
        </div>
        {/* Biome badge in header */}
        {result?.biome && (
          <div style={{ padding:'2px 8px', borderRadius:10, background: BIOME_COLORS[result.biome]?.bg, border:`1px solid ${BIOME_COLORS[result.biome]?.border}`, fontFamily:'var(--mono)', fontSize:9, color: BIOME_COLORS[result.biome]?.color, display:'flex', alignItems:'center', gap:4, whiteSpace:'nowrap' }}>
            <span>{BIOME_ICONS[result.biome]}</span>
            {result.biomeName}
          </div>
        )}
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text3)', padding:4 }}>
          <X size={14} />
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display:'flex', borderBottom:'1px solid var(--border)', padding:'0 16px', flexShrink:0 }}>
        {['metrics','charts','log'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding:'8px 14px', background:'none', cursor:'pointer',
            border:'none', borderBottom:`2px solid ${tab===t?(info?.color||'var(--green)'):'transparent'}`,
            color: tab===t?(info?.color||'var(--green)'):'var(--text3)',
            fontFamily:'var(--mono)', fontSize:11, letterSpacing:1, textTransform:'uppercase', transition:'all 0.15s',
          }}>{t}</button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex:1, overflowY:'auto' }}>
        {tab==='log'     && <JobLog logs={logs} />}
        {tab==='metrics' && result  && <MetricsView result={result} info={info} />}
        {tab==='charts'  && result  && <ChartsView  result={result} info={info} />}
        {tab==='metrics' && !result && <LoadingView />}
        {tab==='charts'  && !result && <LoadingView />}
      </div>
    </div>
  )
}

function LoadingView() {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:200, gap:12 }}>
      <div style={{ width:32, height:32, border:'2px solid var(--border)', borderTopColor:'var(--green)', borderRadius:'50%', animation:'spin 1s linear infinite' }} />
      <div style={{ fontSize:11, color:'var(--text3)', fontFamily:'var(--mono)' }}>PROCESSING...</div>
    </div>
  )
}

// ─── Biome context banner ─────────────────────────────────────────────────────
function BiomeBanner({ result }) {
  if (!result?.biome) return null
  const bc = BIOME_COLORS[result.biome] || BIOME_COLORS.temperate
  return (
    <div style={{ padding:'10px 12px', background:bc.bg, border:`1px solid ${bc.border}`, borderRadius:4, marginBottom:4 }}>
      <div style={{ display:'flex', alignItems:'flex-start', gap:8 }}>
        <span style={{ fontSize:16, flexShrink:0 }}>{BIOME_ICONS[result.biome]}</span>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
            <span style={{ fontFamily:'var(--mono)', fontSize:10, color:bc.color, letterSpacing:1 }}>{result.biomeName?.toUpperCase()}</span>
            <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)' }}>· {result.biomeDataset}</span>
          </div>
          <div style={{ fontSize:10, color:'var(--text2)', lineHeight:1.5 }}>{result.biomeNote}</div>
        </div>
      </div>
    </div>
  )
}

// ─── Accuracy context note for landcover ─────────────────────────────────────
function AccuracyContext({ result }) {
  if (result.task !== 'landcover' || !result.biome) return null
  const bc = BIOME_COLORS[result.biome] || BIOME_COLORS.temperate
  const acc = parseFloat(result.finalAccuracy)

  // Explain what accuracy range means for this biome
  const context = {
    desert:   { expected:'58–72%', why:'Sand, rock and dry soil are spectrally similar — separating them is inherently difficult.', icon:'⚠' },
    tropical: { expected:'76–91%', why:'Dense vegetation creates strong, consistent spectral signatures across classes.', icon:'✓' },
    arctic:   { expected:'68–82%', why:'Ice/snow classes score near-perfect; tundra sub-types are hard to separate.', icon:'✓' },
    alpine:   { expected:'70–84%', why:'Shadow confusion between rock/moraine reduces accuracy for some classes.', icon:'✓' },
    savanna:  { expected:'68–82%', why:'Woody vs herbaceous separation is challenging in dry season imagery.', icon:'⚠' },
    coastal:  { expected:'70–85%', why:'Water depth and turbidity affect spectral response for marine classes.', icon:'✓' },
    wetland:  { expected:'72–86%', why:'Mixed water-vegetation pixels (emergent marsh) are hardest to classify.', icon:'✓' },
    temperate:{ expected:'74–90%', why:'Well-studied biome with the most available training data.', icon:'✓' },
  }
  const ctx = context[result.biome] || context.temperate
  const isLow = acc < 65

  return (
    <div style={{ padding:'9px 11px', background: isLow?'rgba(255,68,85,0.06)':bc.bg, border:`1px solid ${isLow?'rgba(255,68,85,0.3)':bc.border}`, borderRadius:4, marginTop:4 }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
        <span style={{ fontSize:12 }}>{ctx.icon}</span>
        <span style={{ fontFamily:'var(--mono)', fontSize:9, color: isLow?'var(--red)':bc.color, letterSpacing:1 }}>
          ACCURACY CONTEXT · EXPECTED {ctx.expected}
        </span>
      </div>
      <div style={{ fontSize:10, color:'var(--text2)', lineHeight:1.5 }}>{ctx.why}</div>
    </div>
  )
}

// ─── MetricsView ──────────────────────────────────────────────────────────────
function MetricsView({ result, info }) {
  const color = info?.color || 'var(--green)'

  const MetricCard = ({ label, value, unit, highlight, warn }) => (
    <div style={{ padding:'10px 12px', background: highlight?`${color}0d`:warn?'rgba(255,68,85,0.06)':'var(--surface2)', border:`1px solid ${highlight?color+'33':warn?'rgba(255,68,85,0.25)':'var(--border)'}`, borderRadius:4 }}>
      <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:2, marginBottom:6 }}>{label}</div>
      <div style={{ fontSize:16, color: highlight?color:warn?'var(--red)':'var(--text)', fontFamily:'var(--mono)', fontWeight:700 }}>
        {value}{unit && <span style={{ fontSize:10, color:'var(--text3)', marginLeft:4, fontWeight:400 }}>{unit}</span>}
      </div>
    </div>
  )

  return (
    <div style={{ padding:16, display:'flex', flexDirection:'column', gap:12 }}>
      {/* Biome banner */}
      <BiomeBanner result={result} />

      {/* Metadata */}
      <div style={{ padding:'10px 12px', background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4 }}>
        <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:2, marginBottom:8 }}>ANALYSIS METADATA</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8, fontSize:11 }}>
          <MetaRow label="Platform"   value={result.platform} />
          <MetaRow label="Latitude"   value={`${result.lat?.toFixed(4)}°`} />
          <MetaRow label="Longitude"  value={`${result.lon?.toFixed(4)}°`} />
          <MetaRow label="Processing" value={`${result.processingTime?.toFixed(1)}s`} />
          {result.biomeDataset && <MetaRow label="Dataset" value={result.biomeDataset} />}
          {result.biome && <MetaRow label="Biome" value={result.biomeName} />}
        </div>
      </div>

      {/* ── INFERENCE ── */}
      {result.task === 'inference' && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <MetricCard label="RECON LOSS"     value={result.reconstructionLoss} highlight />
            <MetricCard label="MASK RATIO"     value={`${Math.round(result.maskRatio*100)}%`} />
            <MetricCard label="MASKED PATCHES" value={result.maskedPatches} unit={`/ ${result.totalPatches}`} />
            <MetricCard label="IMAGE SIZE"     value={result.imageSize} />
          </div>
          <div>
            <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:2, marginBottom:8 }}>PER-BAND LOSS</div>
            <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
              {result.perBandLoss?.map((loss, i) => (
                <div key={i} style={{ padding:'4px 8px', background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:3, fontSize:10, fontFamily:'var(--mono)', color: parseFloat(loss)>0.03?'var(--orange)':'var(--text2)' }}>
                  B{i+1}: {parseFloat(loss).toFixed(4)}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── EMBEDDINGS ── */}
      {result.task === 'embeddings' && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <MetricCard label="EMBED DIM"      value={result.embedDim} highlight />
            <MetricCard label="PCA VARIANCE"   value={`${result.pcaVariance}%`} />
            <MetricCard label="CHANGE SCORE"   value={result.changeScore} highlight={parseFloat(result.changeScore)>0.4} />
            <MetricCard label="PATCH MEAN MAG" value={result.magnitudeStats?.mean} />
          </div>
          <div>
            <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:2, marginBottom:8 }}>TOP SIMILAR LOCATIONS</div>
            {result.topSimilarLocations?.map(loc => (
              <div key={loc.rank} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', marginBottom:4, background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:3 }}>
                <div style={{ fontSize:11, color:'var(--text3)', width:20 }}>#{loc.rank}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:11, color:'var(--text)', fontFamily:'var(--mono)' }}>{loc.label}</div>
                  <div style={{ fontSize:9, color:'var(--text3)' }}>{loc.lat.toFixed(3)}°, {loc.lon.toFixed(3)}° · {loc.date}</div>
                </div>
                <div style={{ fontSize:12, color, fontFamily:'var(--mono)', fontWeight:700 }}>
                  {(parseFloat(loc.similarity)*100).toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── LAND COVER ── */}
      {result.task === 'landcover' && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <MetricCard label="FINAL ACCURACY" value={`${result.finalAccuracy}%`} highlight warn={parseFloat(result.finalAccuracy)<65} />
            <MetricCard label="FINAL LOSS"     value={result.finalLoss} />
            <MetricCard label="EPOCHS"         value={result.epochs} />
            <MetricCard label="CLASSES"        value={result.numClasses || result.perClassAccuracy?.length} />
          </div>

          {/* Accuracy context */}
          <AccuracyContext result={result} />

          {/* Per-class breakdown */}
          <div>
            <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:2, marginBottom:8 }}>PER-CLASS ACCURACY</div>
            {result.perClassAccuracy?.map(c => {
              const bc = result.biome ? BIOME_COLORS[result.biome] : null
              const barColor = c.accuracy > 80 ? 'var(--green)' : c.accuracy > 60 ? 'var(--orange)' : 'var(--red)'
              return (
                <div key={c.class} style={{ marginBottom:7 }}>
                  <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3, fontSize:10 }}>
                    <span style={{ color:'var(--text2)', fontFamily:'var(--mono)' }}>{c.class}</span>
                    <span style={{ color:barColor, fontFamily:'var(--mono)' }}>{c.accuracy.toFixed(1)}%</span>
                  </div>
                  <div style={{ height:4, background:'var(--surface3)', borderRadius:2, overflow:'hidden' }}>
                    <div style={{ height:'100%', width:`${c.accuracy}%`, background:barColor, borderRadius:2, transition:'width 1s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* ── CLOUD REMOVAL ── */}
      {result.task === 'cloudremoval' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
          <MetricCard label="QUALITY SCORE"   value={`${result.qualityScore}%`} highlight />
          <MetricCard label="CLOUD COVERAGE"  value={result.cloudCoverage} />
          <MetricCard label="MAE"             value={result.mae} />
          <MetricCard label="RMSE"            value={result.rmse} />
          <MetricCard label="SSIM"            value={result.ssim} />
          <MetricCard label="PIXELS RECON."   value={result.reconstructedPixels?.toLocaleString()} />
        </div>
      )}

      {/* ── BAND VIEWER ── */}
      {result.task === 'bands' && (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <MetricCard label="NUM BANDS" value={result.numBands} highlight />
            <MetricCard label="PLATFORM"  value={result.platform?.split('-')[0].toUpperCase()} />
          </div>
          <div>
            <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:2, marginBottom:8 }}>BAND STATISTICS</div>
            {result.statistics?.map((stat, i) => (
              <div key={i} style={{ padding:'8px 10px', marginBottom:4, background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:3 }}>
                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                  <span style={{ fontSize:11, color:'var(--text)', fontFamily:'var(--mono)' }}>{stat.band}</span>
                  <span style={{ fontSize:10, color:'var(--text3)' }}>{result.wavelengths?.[i]?.toFixed(3)}µm</span>
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4, fontSize:9 }}>
                  {[['mean',stat.mean],['std',stat.std],['p2',stat.p2],['p98',stat.p98]].map(([l,v]) => (
                    <div key={l}>
                      <div style={{ color:'var(--text3)' }}>{l}</div>
                      <div style={{ color:'var(--text2)', fontFamily:'var(--mono)' }}>{parseFloat(v).toFixed(0)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── ChartsView ───────────────────────────────────────────────────────────────
function ChartsView({ result, info }) {
  const color = info?.color || 'var(--green)'
  const bc = result?.biome ? BIOME_COLORS[result.biome] : null

  return (
    <div style={{ padding:16, display:'flex', flexDirection:'column', gap:16 }}>

      {/* ── LAND COVER charts ── */}
      {result.task === 'landcover' && (
        <>
          <ChartBlock title="Training Loss Curve" icon={<TrendingDown size={12} />}>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={result.lossHistory}>
                <XAxis dataKey="epoch" stroke="var(--text3)" tick={{ fontSize:10, fill:'var(--text3)' }} />
                <YAxis stroke="var(--text3)" tick={{ fontSize:10, fill:'var(--text3)' }} width={48} />
                <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4, fontSize:11, fontFamily:'var(--mono)' }} />
                <Line type="monotone" dataKey="loss" stroke="#00aaff" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartBlock>

          <ChartBlock title={`Validation Accuracy — ${result.biomeName || ''}`} icon={<Target size={12} />}>
            {bc && (
              <div style={{ padding:'4px 10px 8px', fontSize:9, color:bc.color, fontFamily:'var(--mono)' }}>
                Expected range for this biome shown as dashed line
              </div>
            )}
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={result.accuracyHistory}>
                <XAxis dataKey="epoch" stroke="var(--text3)" tick={{ fontSize:10, fill:'var(--text3)' }} />
                <YAxis stroke="var(--text3)" tick={{ fontSize:10, fill:'var(--text3)' }} width={45} domain={[0,100]} />
                <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4, fontSize:11, fontFamily:'var(--mono)' }} formatter={(v) => [`${v.toFixed(2)}%`, 'Accuracy']} />
                <Line type="monotone" dataKey="accuracy" stroke={bc?.color || color} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartBlock>

          <ChartBlock title="Per-Class Accuracy" icon={<BarChart2 size={12} />}>
            <ResponsiveContainer width="100%" height={Math.max(180, (result.perClassAccuracy?.length||8)*24)}>
              <BarChart data={result.perClassAccuracy} layout="vertical" margin={{ left:4, right:30 }}>
                <XAxis type="number" domain={[0,100]} stroke="var(--text3)" tick={{ fontSize:9, fill:'var(--text3)' }} />
                <YAxis type="category" dataKey="class" stroke="var(--text3)" tick={{ fontSize:9, fill:'var(--text3)' }} width={90} />
                <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4, fontSize:11, fontFamily:'var(--mono)' }} formatter={(v) => [`${v.toFixed(1)}%`, 'Accuracy']} />
                <Bar dataKey="accuracy" radius={[0,2,2,0]}>
                  {result.perClassAccuracy?.map((entry, i) => (
                    <Cell key={i} fill={entry.accuracy>80?'#00ff88':entry.accuracy>60?'#ffaa00':'#ff4455'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartBlock>
        </>
      )}

      {/* ── INFERENCE charts ── */}
      {result.task === 'inference' && result.perBandLoss && (
        <ChartBlock title="Per-Band Reconstruction Loss" icon={<BarChart2 size={12} />}>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={result.perBandLoss.map((loss,i)=>({ band:`B${i+1}`, loss: parseFloat(loss) }))}>
              <XAxis dataKey="band" stroke="var(--text3)" tick={{ fontSize:10, fill:'var(--text3)' }} />
              <YAxis stroke="var(--text3)" tick={{ fontSize:10, fill:'var(--text3)' }} width={52} />
              <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4, fontSize:11, fontFamily:'var(--mono)' }} />
              <Bar dataKey="loss" radius={[2,2,0,0]}>
                {result.perBandLoss.map((loss, i) => (
                  <Cell key={i} fill={parseFloat(loss)>0.03?'#ffaa00':'#00aaff'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartBlock>
      )}

      {/* ── EMBEDDINGS charts ── */}
      {result.task === 'embeddings' && result.topSimilarLocations && (
        <ChartBlock title="Embedding Similarity Scores" icon={<Layers size={12} />}>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={result.topSimilarLocations.map(l=>({ ...l, sim: parseFloat(l.similarity)*100 }))}>
              <XAxis dataKey="label" stroke="var(--text3)" tick={{ fontSize:9, fill:'var(--text3)' }} />
              <YAxis stroke="var(--text3)" tick={{ fontSize:10, fill:'var(--text3)' }} domain={[80,100]} width={42} />
              <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4, fontSize:11, fontFamily:'var(--mono)' }} formatter={(v) => [`${v.toFixed(1)}%`, 'Similarity']} />
              <Bar dataKey="sim" fill={color} radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBlock>
      )}

      {/* ── CLOUD REMOVAL charts ── */}
      {result.task === 'cloudremoval' && (
        <ChartBlock title="Quality Metrics" icon={<Target size={12} />}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, padding:'16px 0' }}>
            {[
              { label:'Quality',  value:result.qualityScore,                        unit:'%', color:'#00ff88' },
              { label:'SSIM',     value:(parseFloat(result.ssim)*100).toFixed(1),   unit:'%', color:'#00aaff' },
              { label:'Coverage', value:parseFloat(result.cloudCoverage),           unit:'%', color:'#ffaa00' },
            ].map(m => (
              <div key={m.label} style={{ textAlign:'center' }}>
                <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:1, marginBottom:8 }}>{m.label}</div>
                <div style={{ width:64, height:64, borderRadius:'50%', margin:'0 auto', border:`3px solid ${m.color}`, display:'flex', alignItems:'center', justifyContent:'center', background:`${m.color}12`, boxShadow:`0 0 16px ${m.color}44` }}>
                  <span style={{ fontSize:14, color:m.color, fontFamily:'var(--mono)', fontWeight:700 }}>{parseFloat(m.value).toFixed(0)}</span>
                </div>
                <div style={{ fontSize:10, color:'var(--text3)', marginTop:6 }}>{m.unit}</div>
              </div>
            ))}
          </div>
        </ChartBlock>
      )}

      {/* ── BAND VIEWER charts ── */}
      {result.task === 'bands' && result.statistics && (
        <ChartBlock title={`Band Mean Reflectance — ${result.biomeName||''}`} icon={<BarChart2 size={12} />}>
          {result.biome === 'desert' && (
            <div style={{ padding:'4px 10px 6px', fontSize:9, color:'#ff9100', fontFamily:'var(--mono)' }}>
              ⚠ High SWIR reflectance typical of arid/sand surfaces
            </div>
          )}
          {result.biome === 'tropical' && (
            <div style={{ padding:'4px 10px 6px', fontSize:9, color:'#00e676', fontFamily:'var(--mono)' }}>
              ✓ Elevated NIR reflectance from dense vegetation canopy
            </div>
          )}
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={result.statistics.map((s,i)=>({ ...s, wavelength: result.wavelengths?.[i]?.toFixed(2) }))}>
              <XAxis dataKey="wavelength" stroke="var(--text3)" tick={{ fontSize:9, fill:'var(--text3)' }} label={{ value:'µm', position:'insideBottomRight', fill:'var(--text3)', fontSize:9 }} />
              <YAxis stroke="var(--text3)" tick={{ fontSize:9, fill:'var(--text3)' }} width={45} />
              <Tooltip contentStyle={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4, fontSize:11, fontFamily:'var(--mono)' }} />
              <Bar dataKey="mean" fill={color} radius={[2,2,0,0]} />
            </BarChart>
          </ResponsiveContainer>
        </ChartBlock>
      )}
    </div>
  )
}

function ChartBlock({ title, icon, children }) {
  return (
    <div style={{ background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4, overflow:'hidden' }}>
      <div style={{ padding:'10px 14px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:8, fontSize:11, color:'var(--text2)', fontFamily:'var(--mono)' }}>
        <span style={{ color:'var(--text3)' }}>{icon}</span>
        {title}
      </div>
      <div style={{ padding:'12px 8px 8px' }}>{children}</div>
    </div>
  )
}

function MetaRow({ label, value }) {
  return (
    <div>
      <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:1 }}>{label}</div>
      <div style={{ fontSize:11, color:'var(--text)', fontFamily:'var(--mono)' }}>{value}</div>
    </div>
  )
}
