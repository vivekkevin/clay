import { useRef, useEffect, useState, useCallback } from 'react'
const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_ACCESS_TOKEN

const MAP_STYLES = {
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  dark:      'mapbox://styles/mapbox/dark-v11',
  terrain:   'mapbox://styles/mapbox/outdoors-v12',
}

const CLASSES = {
  1: { name:'Water',         color:'#1565c0' },
  2: { name:'Dense Veg',     color:'#1b5e20' },
  3: { name:'Vegetation',    color:'#43a047' },
  4: { name:'Impervious',    color:'#c62828' },
  5: { name:'Barren',        color:'#8d6e63' },
  6: { name:'Wetland/Scrub', color:'#6a1b9a' },
}

const PHASE_COLORS = {
  model:'#aa00ff', download:'#2979ff', indices:'#ff9100',
  train:'#ff5252', predict:'#00e676', export:'#8bb0cc',
}

const LAYER_META = {
  satellite:  { label:'Satellite',   desc:'Real imagery',            color:'#8bb0cc' },
  lulc:       { label:'LULC',        desc:'Land use classification', color:'#00e676' },
  ndvi:       { label:'NDVI',        desc:'Vegetation index',        color:'#43a047' },
  confidence: { label:'Confidence',  desc:'Model confidence',        color:'#2979ff' },
  change:     { label:'Change',      desc:'Multi-year change map',   color:'#ff9100' },
  error:      { label:'Error',       desc:'Prediction error',        color:'#ff5252' },
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)]
}

// Generate pixel buffers for overlays
function genLULC(w, h) {
  const d = new Uint8ClampedArray(w*h*4)
  const cols = Object.values(CLASSES).map(c => hexToRgb(c.color))
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    const i=(y*w+x)*4, nx=x/w, ny=y/h
    const v = Math.sin(nx*12)*Math.cos(ny*9)*0.4 + Math.sin((nx+ny)*7)*0.3 + Math.cos(nx*5-ny*11)*0.3
    let cls = Math.floor(((v+0.75)/1.5)*cols.length)
    cls = Math.max(0,Math.min(cols.length-1,cls))
    d[i]=cols[cls][0]; d[i+1]=cols[cls][1]; d[i+2]=cols[cls][2]; d[i+3]=200
  }
  return d
}

function genNDVI(w, h) {
  const d = new Uint8ClampedArray(w*h*4)
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    const i=(y*w+x)*4, nx=x/w, ny=y/h
    const v = (Math.sin(nx*8)*Math.cos(ny*6)*0.5 + Math.sin(nx*3+ny*5)*0.3 + 0.85)/1.4
    d[i]  =v<0.5?Math.floor(v*2*200+55):0
    d[i+1]=v>0.5?Math.floor((v-.5)*2*200+55):0
    d[i+2]=v<0.4?Math.floor((0.4-v)*300):0
    d[i+3]=200
  }
  return d
}

function genConfidence(w, h) {
  const d = new Uint8ClampedArray(w*h*4)
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    const i=(y*w+x)*4, nx=x/w, ny=y/h
    const v = Math.max(0,Math.min(1,(Math.sin(nx*6+.5)*Math.cos(ny*5+.3)*0.2+1.0)/1.2))
    d[i]=Math.floor(v<0.5?v*2*255:255); d[i+1]=0; d[i+2]=Math.floor(v>0.5?(1-v)*2*255:255); d[i+3]=200
  }
  return d
}

function genChange(w, h) {
  const d = new Uint8ClampedArray(w*h*4)
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    const i=(y*w+x)*4, nx=x/w, ny=y/h
    const v = Math.sin(nx*9)*Math.cos(ny*8)*0.5 + Math.sin((nx-ny)*6)*0.4
    let r,g,b
    if      (v<-0.3){r=21;g=101;b=192}
    else if (v<-0.1){r=198;g=40;b=40}
    else if (v<0.1) {r=230;g=204;b=26}
    else if (v<0.3) {r=27;g=158;b=27}
    else            {r=70;g=70;b=70}
    d[i]=r;d[i+1]=g;d[i+2]=b;d[i+3]=200
  }
  return d
}

function genError(w, h) {
  const d = new Uint8ClampedArray(w*h*4)
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
    const i=(y*w+x)*4, nx=x/w, ny=y/h
    const isErr = Math.sin(nx*15+1)*Math.cos(ny*13+2) > 0.2
    d[i]=isErr?220:15; d[i+1]=isErr?25:128; d[i+2]=isErr?25:15; d[i+3]=isErr?200:100
  }
  return d
}

export default function LULCMap({ lulcState, mapStyle }) {
  const mapContainer  = useRef(null)
  const mapRef        = useRef(null)
  const canvasRef     = useRef(null)
  const animRef       = useRef()
  const buffers       = useRef({})
  const [mapLoaded, setMapLoaded]     = useState(false)
  const [coord, setCoord]             = useState({ lat:'11.0041', lon:'77.0066' })
  const [aoiPoints, setAoiPoints]     = useState(null)
  const centerRef = useRef({ lat: 11.0, lon: 77.0 })

  // ── Init Mapbox for LULC mode ─────────────────────────────
  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return
    import('mapbox-gl').then(({ default: mapboxgl }) => {
      mapboxgl.accessToken = MAPBOX_TOKEN
      const m = new mapboxgl.Map({
        container: mapContainer.current,
        style: MAP_STYLES[mapStyle] || MAP_STYLES.satellite,
        center: [centerRef.current.lon, centerRef.current.lat],
        zoom: 8, antialias: true,
      })
      m.addControl(new mapboxgl.NavigationControl(), 'top-right')
      m.addControl(new mapboxgl.ScaleControl({ unit:'metric' }), 'bottom-right')
      m.on('style.load', () => setMapLoaded(true))
      m.on('mousemove', (e) => {
        setCoord({ lat: e.lngLat.lat.toFixed(4), lon: e.lngLat.lng.toFixed(4) })
      })
      mapRef.current = m
    })
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null } }
  }, [])

  // Map style change
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return
    mapRef.current.setStyle(MAP_STYLES[mapStyle] || MAP_STYLES.satellite)
    mapRef.current.once('style.load', () => {
      // Re-add LULC source after style reload
      if (lulcState?.results) setTimeout(() => addLULCSource(), 300)
    })
  }, [mapStyle])

  // ── Build pixel buffers ───────────────────────────────────
  const rebuildBuffers = useCallback((w, h) => {
    buffers.current = {
      lulc:       genLULC(w, h),
      ndvi:       genNDVI(w, h),
      confidence: genConfidence(w, h),
      change:     genChange(w, h),
      error:      genError(w, h),
    }
  }, [])

  // ── Add LULC as Mapbox canvas source ─────────────────────
  const addLULCSource = useCallback(() => {
    if (!mapRef.current || !canvasRef.current) return
    // Remove existing
    try { if (mapRef.current.getLayer('lulc-overlay')) mapRef.current.removeLayer('lulc-overlay') } catch {}
    try { if (mapRef.current.getSource('lulc-canvas')) mapRef.current.removeSource('lulc-canvas') } catch {}

    const m = mapRef.current
    const bounds = m.getBounds()
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast()

    m.addSource('lulc-canvas', {
      type: 'canvas',
      canvas: canvasRef.current,
      coordinates: [
        [sw.lng, ne.lat], [ne.lng, ne.lat],
        [ne.lng, sw.lat], [sw.lng, sw.lat],
      ],
      animate: false,
    })
    m.addLayer({
      id: 'lulc-overlay', type: 'raster', source: 'lulc-canvas',
      paint: { 'raster-opacity': (lulcState?.overlayOpacity ?? 70)/100, 'raster-resampling':'linear' },
    })
  }, [lulcState])

  // Update opacity live
  useEffect(() => {
    if (!mapRef.current) return
    try { mapRef.current.setPaintProperty('lulc-overlay','raster-opacity', (lulcState?.overlayOpacity??70)/100) } catch {}
  }, [lulcState?.overlayOpacity])

  // ── Draw overlay on canvas ────────────────────────────────
  const drawOverlay = useCallback(() => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    const w = cv.width, h = cv.height
    const layer    = lulcState?.activeLayer || 'satellite'
    const running  = lulcState?.running || false
    const progress = lulcState?.progress || 0
    const phase    = lulcState?.currentPhase || ''
    const hasResults = !!lulcState?.results

    ctx.clearRect(0, 0, w, h)

    // Only draw overlay for non-satellite layers, or satellite+results
    if (layer === 'satellite' && !hasResults && !running) return

    let bytes = null
    if (layer === 'lulc' || (layer === 'satellite' && (hasResults || running))) bytes = buffers.current.lulc
    else if (layer === 'ndvi')       bytes = buffers.current.ndvi
    else if (layer === 'confidence') bytes = buffers.current.confidence
    else if (layer === 'change')     bytes = buffers.current.change
    else if (layer === 'error')      bytes = buffers.current.error

    if (!bytes) return

    if (running) {
      // Reveal top-down as progress increases
      const revealRows = Math.floor((progress / 98) * h)
      if (revealRows > 0) {
        const img = new ImageData(new Uint8ClampedArray(bytes), w, h)
        const oc = document.createElement('canvas'); oc.width=w; oc.height=h
        oc.getContext('2d').putImageData(img, 0, 0)
        ctx.drawImage(oc, 0, 0, w, revealRows, 0, 0, w, revealRows)
      }
      // Scan line
      const sy = Math.floor((progress/98)*h)
      const pc = PHASE_COLORS[phase] || '#00e676'
      const grd = ctx.createLinearGradient(0, sy-30, 0, sy+30)
      grd.addColorStop(0,'rgba(0,0,0,0)'); grd.addColorStop(0.5,pc+'cc'); grd.addColorStop(1,'rgba(0,0,0,0)')
      ctx.fillStyle=grd; ctx.fillRect(0,sy-30,w,60)
      ctx.save(); ctx.strokeStyle=pc; ctx.lineWidth=2; ctx.shadowColor=pc; ctx.shadowBlur=10
      ctx.beginPath(); ctx.moveTo(0,sy); ctx.lineTo(w,sy); ctx.stroke(); ctx.restore()
      animRef.current = requestAnimationFrame(drawOverlay)
    } else {
      // Full overlay
      ctx.putImageData(new ImageData(new Uint8ClampedArray(bytes), w, h), 0, 0)
    }

    // Refresh canvas source
    try {
      const src = mapRef.current?.getSource('lulc-canvas')
      if (src) src.play()
    } catch {}
  }, [lulcState])

  // Resize canvas to map container size
  useEffect(() => {
    const el = mapContainer.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (canvasRef.current) {
        canvasRef.current.width  = el.clientWidth
        canvasRef.current.height = el.clientHeight
        rebuildBuffers(el.clientWidth, el.clientHeight)
        drawOverlay()
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [rebuildBuffers, drawOverlay])

  // Re-draw when state changes
  useEffect(() => {
    cancelAnimationFrame(animRef.current)
    drawOverlay()
    return () => cancelAnimationFrame(animRef.current)
  }, [drawOverlay])

  // Add/update canvas source when results arrive or layer changes
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return
    const layer = lulcState?.activeLayer || 'satellite'
    const hasResults = !!lulcState?.results
    const running = lulcState?.running || false

    if (layer !== 'satellite' || hasResults || running) {
      if (!mapRef.current.getSource('lulc-canvas')) {
        addLULCSource()
      }
    } else {
      try { if (mapRef.current.getLayer('lulc-overlay')) mapRef.current.removeLayer('lulc-overlay') } catch {}
      try { if (mapRef.current.getSource('lulc-canvas')) mapRef.current.removeSource('lulc-canvas') } catch {}
    }
  }, [lulcState?.activeLayer, lulcState?.results, lulcState?.running, mapLoaded, addLULCSource])

  // Fly to AOI when loaded
  useEffect(() => {
    if (!lulcState?.aoi || !mapRef.current || !mapLoaded) return
    const coords = []
    const harvest = (obj) => {
      if (!obj) return
      if (obj.type==='FeatureCollection') obj.features?.forEach(harvest)
      else if (obj.type==='Feature') harvest(obj.geometry)
      else if (obj.type==='Polygon') obj.coordinates?.[0]?.forEach(c=>coords.push(c))
    }
    harvest(lulcState.aoi)
    if (!coords.length) return
    const lons=coords.map(c=>c[0]), lats=coords.map(c=>c[1])
    const minLon=Math.min(...lons), maxLon=Math.max(...lons)
    const minLat=Math.min(...lats), maxLat=Math.max(...lats)
    const cLon=(minLon+maxLon)/2, cLat=(minLat+maxLat)/2
    centerRef.current = { lat:cLat, lon:cLon }
    mapRef.current.flyTo({ center:[cLon, cLat], zoom:10, duration:2000 })

    // Draw AOI polygon on map
    import('mapbox-gl').then(() => {
      try {
        if (mapRef.current.getLayer('aoi-line')) mapRef.current.removeLayer('aoi-line')
        if (mapRef.current.getLayer('aoi-fill')) mapRef.current.removeLayer('aoi-fill')
        if (mapRef.current.getSource('aoi-source')) mapRef.current.removeSource('aoi-source')
      } catch {}
      mapRef.current.addSource('aoi-source', { type:'geojson', data: lulcState.aoi })
      mapRef.current.addLayer({ id:'aoi-fill', type:'fill', source:'aoi-source', paint:{ 'fill-color':'#ff9100', 'fill-opacity':0.06 } })
      mapRef.current.addLayer({ id:'aoi-line', type:'line', source:'aoi-source', paint:{ 'line-color':'#ff9100', 'line-width':2, 'line-dasharray':[4,3] } })
    })
  }, [lulcState?.aoi, mapLoaded])

  const layer      = lulcState?.activeLayer || 'satellite'
  const hasResults = !!lulcState?.results
  const running    = lulcState?.running || false
  const progress   = lulcState?.progress || 0
  const phase      = lulcState?.currentPhase || ''
  const phaseColor = PHASE_COLORS[phase] || '#00e676'
  const layerMeta  = LAYER_META[layer] || LAYER_META.satellite

  return (
    <div style={{ position:'relative', flex:1, overflow:'hidden' }}>
      {/* Mapbox map fills the area */}
      <div ref={mapContainer} style={{ position:'absolute', inset:0 }} />

      {/* Invisible canvas used as Mapbox canvas source for overlays */}
      <canvas ref={canvasRef} style={{ display:'none' }} />

      {/* ── Top-left: layer badge ── */}
      <div style={{ position:'absolute', top:12, left:12, display:'flex', gap:5, zIndex:5, flexWrap:'wrap' }}>
        <div style={{ padding:'5px 11px', borderRadius:4, background:'rgba(5,7,9,.90)', border:`1px solid ${layerMeta.color}55`, fontFamily:'var(--mono)', fontSize:10, color:layerMeta.color, letterSpacing:1.5, backdropFilter:'blur(8px)', display:'flex', alignItems:'center', gap:7 }}>
          <div style={{ width:6, height:6, borderRadius:2, background:layerMeta.color }} />
          {layerMeta.label.toUpperCase()}
          <span style={{ color:'var(--text3)', fontSize:9 }}>· {layerMeta.desc}</span>
        </div>
        {running && (
          <div style={{ padding:'5px 11px', borderRadius:4, background:`${phaseColor}18`, border:`1px solid ${phaseColor}66`, fontFamily:'var(--mono)', fontSize:10, color:phaseColor, backdropFilter:'blur(8px)' }}>
            {phase.toUpperCase()}
          </div>
        )}
        {hasResults && !running && (
          <div style={{ padding:'5px 11px', borderRadius:4, background:'rgba(0,255,136,.08)', border:'1px solid rgba(0,255,136,.3)', fontFamily:'var(--mono)', fontSize:10, color:'var(--green)', backdropFilter:'blur(8px)' }}>
            IoU {lulcState.results.iou.toFixed(3)} · Acc {lulcState.results.acc.toFixed(1)}%
          </div>
        )}
      </div>

      {/* ── GeoTIFF output list (top-right) ── */}
      {hasResults && !running && (
        <div style={{ position:'absolute', top:12, right:14, background:'rgba(5,7,9,.94)', border:'1px solid var(--border2)', borderRadius:6, padding:'10px 13px', backdropFilter:'blur(10px)', zIndex:5, minWidth:210 }}>
          <div style={{ fontFamily:'var(--mono)', fontSize:8, letterSpacing:2, color:'var(--text3)', marginBottom:8 }}>GEOTIFF OUTPUTS</div>
          {[
            { file:'lulc_prediction.tif', lyr:'lulc',       col:'#00e676', lbl:'LULC Map'      },
            { file:'ndvi.tif',            lyr:'ndvi',        col:'#43a047', lbl:'NDVI'          },
            { file:'confidence.tif',      lyr:'confidence',  col:'#2979ff', lbl:'Confidence'    },
            { file:'change_map.tif',      lyr:'change',      col:'#ff9100', lbl:'Change Map'    },
            { file:'lulc_rgb.tif',        lyr:'satellite',   col:'#8bb0cc', lbl:'RGB Composite' },
          ].map(item => {
            const isActive = layer === item.lyr
            return (
              <div key={item.file} style={{ display:'flex', alignItems:'center', gap:7, marginBottom:5, padding:'3px 5px', borderRadius:3, background:isActive?item.col+'14':'transparent', border:`1px solid ${isActive?item.col+'44':'transparent'}`, transition:'all .15s' }}>
                <div style={{ width:8, height:8, borderRadius:2, background:item.col, flexShrink:0, boxShadow:isActive?`0 0 6px ${item.col}`:'none' }} />
                <div style={{ flex:1 }}>
                  <div style={{ fontFamily:'var(--mono)', fontSize:10, color:isActive?item.col:'var(--text2)' }}>{item.lbl}</div>
                  <div style={{ fontFamily:'var(--mono)', fontSize:8, color:'var(--text3)' }}>{item.file}</div>
                </div>
                <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)', cursor:'pointer' }}
                  onMouseEnter={e=>e.currentTarget.style.color='var(--green)'}
                  onMouseLeave={e=>e.currentTarget.style.color='var(--text3)'}>⬇</span>
              </div>
            )
          })}
        </div>
      )}

      {/* ── PROCESSING overlay card ── */}
      {running && (
        <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'rgba(5,7,9,0.93)', border:`1px solid ${phaseColor}66`, borderRadius:8, padding:'20px 28px', textAlign:'center', backdropFilter:'blur(14px)', zIndex:10, minWidth:320, boxShadow:`0 0 40px ${phaseColor}22` }}>
          <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)', letterSpacing:2.5, marginBottom:6 }}>
            YEAR {lulcState.currentYear} · STEP {(lulcState.stepIndex||0)+1}/{lulcState.totalSteps||15}
          </div>
          <div style={{ display:'inline-block', padding:'2px 10px', borderRadius:20, background:`${phaseColor}22`, border:`1px solid ${phaseColor}55`, fontFamily:'var(--mono)', fontSize:9, color:phaseColor, letterSpacing:1.5, marginBottom:12 }}>
            {phase.toUpperCase()}
          </div>
          <div style={{ fontFamily:'var(--mono)', fontSize:12, color:'var(--text)', marginBottom:16, minHeight:18, lineHeight:1.5 }}>
            {lulcState.currentStep}
          </div>
          <div style={{ height:3, background:'rgba(255,255,255,.08)', borderRadius:2, overflow:'hidden', marginBottom:8 }}>
            <div style={{ height:'100%', width:progress+'%', background:`linear-gradient(90deg,var(--blue),${phaseColor})`, transition:'width .4s ease', boxShadow:`0 0 8px ${phaseColor}` }} />
          </div>
          <div style={{ display:'flex', justifyContent:'center', gap:6, marginBottom:10 }}>
            {(lulcState.selectedYears||[]).map(yr => {
              const isDone=yr<lulcState.currentYear, isCurr=yr===lulcState.currentYear
              return <div key={yr} style={{ width:isCurr?32:8, height:8, borderRadius:4, background:isDone?'var(--green)':isCurr?phaseColor:'rgba(255,255,255,.12)', transition:'all .3s', display:'flex', alignItems:'center', justifyContent:'center' }}>
                {isCurr&&<span style={{ fontFamily:'var(--mono)', fontSize:7, color:'#000', fontWeight:700 }}>{yr}</span>}
              </div>
            })}
          </div>
          <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)' }}>
            {progress}% complete{lulcState.totalYears>1?` · year ${(lulcState.yearIndex||0)+1} of ${lulcState.totalYears}`:''}
          </div>
        </div>
      )}

      {/* ── LULC legend ── */}
      {(layer==='lulc'||(layer==='satellite'&&hasResults))&&!running&&(
        <div style={{ position:'absolute', bottom:50, right:14, background:'rgba(5,7,9,.93)', border:'1px solid var(--border)', borderRadius:5, padding:'10px 13px', backdropFilter:'blur(8px)', zIndex:5 }}>
          <div style={{ fontFamily:'var(--mono)', fontSize:8, letterSpacing:2, color:'var(--text3)', marginBottom:7 }}>LULC CLASSES</div>
          {Object.entries(CLASSES).map(([id,cls])=>(
            <div key={id} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4, fontFamily:'var(--mono)', fontSize:10, color:'var(--text2)' }}>
              <div style={{ width:10, height:10, borderRadius:2, background:cls.color, flexShrink:0 }} />
              {cls.name}
              {hasResults&&<span style={{ marginLeft:'auto', paddingLeft:10, color:'var(--text3)', fontSize:9 }}>{lulcState.results.perClass[id]?.area.toFixed(1)}%</span>}
            </div>
          ))}
        </div>
      )}

      {/* ── NDVI legend ── */}
      {layer==='ndvi'&&!running&&(
        <div style={{ position:'absolute', bottom:50, right:14, background:'rgba(5,7,9,.93)', border:'1px solid var(--border)', borderRadius:5, padding:'10px 13px', backdropFilter:'blur(8px)', zIndex:5 }}>
          <div style={{ fontFamily:'var(--mono)', fontSize:8, letterSpacing:2, color:'var(--text3)', marginBottom:7 }}>NDVI</div>
          {[['HIGH > 0.6','#006400'],['MED 0.3–0.6','#ffd700'],['LOW < 0.3','#8b4513']].map(([l,c])=>(
            <div key={l} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
              <div style={{ width:10, height:10, borderRadius:2, background:c }} />
              <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text2)' }}>{l}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Change legend ── */}
      {layer==='change'&&!running&&(
        <div style={{ position:'absolute', bottom:50, right:14, background:'rgba(5,7,9,.93)', border:'1px solid var(--border)', borderRadius:5, padding:'10px 13px', backdropFilter:'blur(8px)', zIndex:5 }}>
          <div style={{ fontFamily:'var(--mono)', fontSize:8, letterSpacing:2, color:'var(--text3)', marginBottom:7 }}>CHANGE MAP</div>
          {[['No change','#464646'],['+Impervious','#c62828'],['-Vegetation','#e6cc1a'],['+Vegetation','#1b9e1b'],['+Water','#1565c0']].map(([l,c])=>(
            <div key={l} style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
              <div style={{ width:10, height:10, borderRadius:2, background:c }} />
              <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text2)' }}>{l}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Coord + meta ── */}
      <div style={{ position:'absolute', bottom:50, left:14, background:'rgba(5,7,9,.88)', border:'1px solid var(--border)', borderRadius:5, padding:'9px 13px', backdropFilter:'blur(8px)', zIndex:5 }}>
        <div style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--orange)', marginBottom:3 }}>{coord.lat}° N,  {coord.lon}° E</div>
        <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)' }}>
          {lulcState?.platform==='sentinel2'?'Sentinel-2 L2A · 10m':'Landsat 8/9 · 30m'}
          {lulcState?.aoiName?` · ${lulcState.aoiName}`:' · Drop GeoJSON to set AOI'}
        </div>
        {hasResults&&!running&&(
          <div style={{ marginTop:6, display:'flex', gap:10, fontFamily:'var(--mono)', fontSize:9 }}>
            <span style={{ color:'var(--green)' }}>IoU {lulcState.results.iou.toFixed(4)}</span>
            <span style={{ color:'var(--blue)' }}>F1 {lulcState.results.f1.toFixed(4)}</span>
          </div>
        )}
      </div>

      {/* ── Empty state ── */}
      {!hasResults&&!running&&(
        <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', textAlign:'center', pointerEvents:'none', zIndex:1 }}>
          <div style={{ fontFamily:'var(--mono)', fontSize:11, color:'rgba(74,106,132,.5)', letterSpacing:2 }}>
            UPLOAD GEOJSON · SELECT YEARS · RUN PIPELINE
          </div>
        </div>
      )}
    </div>
  )
}
