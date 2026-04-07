import { useEffect, useRef, useState, useCallback } from 'react'
import { getLocations, PLATFORM_COLORS } from '../utils/api.js'

const MAPBOX_TOKEN = process.env.REACT_APP_MAPBOX_ACCESS_TOKEN

const MAP_STYLES = {
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
  dark:      'mapbox://styles/mapbox/dark-v11',
  terrain:   'mapbox://styles/mapbox/outdoors-v12',
}

const PC_STAC    = 'https://planetarycomputer.microsoft.com/api/stac/v1'
const PC_TITILER = 'https://planetarycomputer.microsoft.com/api/data/v1'

// ── Render configs ────────────────────────────────────────────────────────────
// rescale values match actual DN ranges per collection:
//   Sentinel-2 L2A: 0–10000 (reflectance * 10000)
//   Landsat C2 L2:  surface reflectance 0–65535 (scale 0.0000275 offset -0.2)
//   Sentinel-1 RTC: dB values -20 to 0
const RENDER_CFG = {
  'sentinel-2-l2a': {
    collection: 'sentinel-2-l2a',
    renders: [
      { id:'natural',    label:'Natural Color',
        color:'#00e676', assets:['B04','B03','B02'],
        // rescale per-band: each asset gets its own rescale
        rescales:['0,3000','0,3000','0,3000'] },
      { id:'falsecolor', label:'False Color NIR',
        color:'#ff6b35', assets:['B08','B04','B03'],
        rescales:['0,5000','0,3000','0,3000'] },
      { id:'ndvi',       label:'NDVI',
        color:'#43a047', assets:['B08','B04'],
        expression:'(B08-B04)/(B08+B04+1)', rescale:'-1,1', colormap:'rdylgn' },
      { id:'ndwi',       label:'NDWI',
        color:'#1565c0', assets:['B03','B08'],
        expression:'(B03-B08)/(B03+B08+1)', rescale:'-1,1', colormap:'blues_r' },
      { id:'swir',       label:'SWIR',
        color:'#ff9100', assets:['B12','B8A','B04'],
        rescales:['0,5000','0,5000','0,3000'] },
    ],
  },
  'landsat-c2-l2': {
    collection: 'landsat-c2-l2',
    renders: [
      { id:'natural',    label:'Natural Color',
        color:'#00e676', assets:['red','green','blue'],
        rescales:['7000,20000','7000,20000','7000,20000'] },
      { id:'falsecolor', label:'False Color NIR',
        color:'#ff6b35', assets:['nir08','red','green'],
        rescales:['5000,25000','7000,20000','7000,20000'] },
      { id:'ndvi',       label:'NDVI',
        color:'#43a047', assets:['nir08','red'],
        expression:'(nir08-red)/(nir08+red+1)', rescale:'-1,1', colormap:'rdylgn' },
      { id:'swir',       label:'SWIR',
        color:'#ff9100', assets:['swir22','nir08','red'],
        rescales:['3000,18000','5000,25000','7000,20000'] },
      { id:'thermal',    label:'Thermal',
        color:'#ff5252', assets:['lwir11'],
        rescale:'27000,33000', colormap:'inferno' },
    ],
  },
  'sentinel-1-rtc': {
    collection: 'sentinel-1-rtc',
    renders: [
      { id:'vv',   label:'VV',    color:'#8bb0cc', assets:['vv'],      rescale:'-20,0',  colormap:'greys' },
      { id:'vh',   label:'VH',    color:'#7090b8', assets:['vh'],      rescale:'-25,-5', colormap:'greys' },
      { id:'vvvh', label:'VV+VH', color:'#58a6ff', assets:['vv','vh'], rescales:['-20,0','-25,-5'] },
    ],
  },
  'naip': {
    collection: 'naip',
    renders: [
      { id:'natural', label:'True Color',     color:'#00e676', assets:['image'], bidx:'1,2,3', rescale:'0,255' },
      { id:'cir',     label:'Color Infrared', color:'#ff6b35', assets:['image'], bidx:'4,1,2', rescale:'0,255' },
    ],
  },
}

const PLATFORM_TO_CFG = {
  'sentinel-2-l2a':  RENDER_CFG['sentinel-2-l2a'],
  'sentinel-1-rtc':  RENDER_CFG['sentinel-1-rtc'],
  'landsat-c2l2-sr': RENDER_CFG['landsat-c2-l2'],
  'landsat-c2l1':    RENDER_CFG['landsat-c2-l2'],
  'naip':            RENDER_CFG['naip'],
}

// ── Sign item via PC STAC ─────────────────────────────────────────────────────
async function signItem(collection, itemId) {
  try {
    const r1 = await fetch(`${PC_STAC}/collections/${collection}/items/${itemId}`)
    if (!r1.ok) return null
    const item = await r1.json()
    const r2 = await fetch(`${PC_STAC}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    })
    return r2.ok ? await r2.json() : item
  } catch { return null }
}

// ── Build tile URL from item ID with correct per-band rescale ─────────────────
function buildSignedTileUrl(item, render, collection) {
  const base = `${PC_TITILER}/item/tiles/WebMercatorQuad/{z}/{x}/{y}@2x.png`
  const p = new URLSearchParams()
  p.set('collection', collection)
  p.set('item', item.id)

  render.assets.forEach(a => p.append('assets', a))

  // Per-band rescale — one rescale value per asset
  const rescales = render.rescales || render.assets.map(() => render.rescale || '0,3000')
  rescales.forEach(r => p.append('rescale', r))

  if (render.colormap)   p.set('colormap_name', render.colormap)
  if (render.expression) p.set('expression', render.expression)
  if (render.bidx)       p.set('asset_bidx', `image|${render.bidx}`)

  // unscale: let titiler apply collection-level scale/offset for Landsat SR values
  if (collection.includes('landsat')) p.set('unscale', 'true')

  return `${base}?${p.toString()}`
}

// ── Build a preview URL using PC's pre-rendered tile system ───────────────────
// PC hosts pre-rendered tiles per collection — fastest and most reliable
function buildPreviewTileUrl(collection, itemId, renderId) {
  // PC data API collection-level rendered tiles
  const base = `${PC_TITILER}/item/tiles/WebMercatorQuad/{z}/{x}/{y}@2x.png`
  const p = new URLSearchParams()
  p.set('collection', collection)
  p.set('item', itemId)

  // Use PC's built-in render presets (e.g. "natural color", "color infrared")
  // These are defined in the collection's STAC metadata
  if (renderId) p.set('render', renderId)

  return `${base}?${p.toString()}`
}

// ── Build fallback URL using visual/rendered_preview asset ────────────────────
function buildRenderedPreviewUrl(signedItem) {
  const asset = signedItem?.assets?.rendered_preview || signedItem?.assets?.visual
  if (!asset?.href) return null
  // Use /cog/tiles to serve the rendered preview COG
  const base = `${PC_TITILER}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}@2x.png`
  const p = new URLSearchParams()
  p.set('url', asset.href)
  p.set('rescale', '0,255')
  p.set('nodata', '0')
  return `${base}?${p.toString()}`
}

// Fetch STAC scenes
async function fetchScenes(collection, bbox, limit = 15) {
  try {
    const body = {
      collections: [collection], bbox, limit,
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    }
    if (!collection.includes('sentinel-1')) body.query = { 'eo:cloud_cover': { lt: 30 } }
    const r = await fetch(`${PC_STAC}/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!r.ok) return []
    return (await r.json()).features || []
  } catch { return [] }
}

// Get thumbnail download URL for a scene
function getThumbnailUrl(scene) {
  return scene.assets?.thumbnail?.href
    || scene.assets?.rendered_preview?.href
    || scene.assets?.overview?.href
    || null
}

function safeRm(map, ids) {
  ids.forEach(id => {
    try { if (map.getLayer(id)) map.removeLayer(id) } catch {}
    try { if (map.getSource(id)) map.removeSource(id) } catch {}
  })
}

const TILE_SRC = 'pc-tile-src'
const TILE_LYR = 'pc-tile-lyr'

export default function MapPanel({ selectedLocation, onLocationSelect, mapStyle, onHover, onSceneSelect }) {
  const mapContainer = useRef(null)
  const mapRef       = useRef(null)
  const markersRef   = useRef({})
  const clickMarker  = useRef(null)
  const cfgRef       = useRef(RENDER_CFG['sentinel-2-l2a'])
  const scenesRef    = useRef([])
  const opacityRef   = useRef(100)
  const doSelectRef  = useRef(null)
  const fpCountRef   = useRef(0)
  const lastSceneRef = useRef(null)
  const lastRenderRef= useRef(null)

  const [mapLoaded,   setMapLoaded]   = useState(false)
  const [locations,   setLocations]   = useState([])
  const [clickCoords, setClickCoords] = useState(null)
  const [scenes,      setScenes]      = useState([])
  const [searching,   setSearching]   = useState(false)
  const [showPanel,   setShowPanel]   = useState(false)
  const [selScene,    setSelScene]    = useState(null)
  const [selRender,   setSelRender]   = useState(null)
  const [opacity,     setOpacity]     = useState(100)
  const [tileLoading, setTileLoading] = useState(false)
  const [tileStatus,  setTileStatus]  = useState('')   // status message
  const [metaTab,     setMetaTab]     = useState(null)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => { getLocations().then(d => setLocations(d.locations || [])) }, [])
  useEffect(() => { opacityRef.current = opacity }, [opacity])
  useEffect(() => { scenesRef.current  = scenes  }, [scenes])

  // ── Init Mapbox ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current || !mapContainer.current) return
    import('mapbox-gl').then(({ default: mgl }) => {
      mgl.accessToken = MAPBOX_TOKEN
      const m = new mgl.Map({
        container: mapContainer.current,
        style: MAP_STYLES.satellite,
        center: [20, 15], zoom: 2.5,
        projection: 'globe', antialias: true,
      })
      m.addControl(new mgl.NavigationControl(), 'top-right')
      m.addControl(new mgl.ScaleControl({ unit: 'metric' }), 'bottom-right')
      m.on('style.load', () => {
        m.setFog({ color:'rgb(2,5,10)', 'high-color':'rgb(10,30,50)', 'horizon-blend':0.04, 'space-color':'rgb(5,7,9)', 'star-intensity':0.8 })
        setMapLoaded(true)
      })
      m.on('click', e => {
        if (e.defaultPrevented) return
        const { lng, lat } = e.lngLat
        setClickCoords({ lat: lat.toFixed(5), lon: lng.toFixed(5) })
        if (clickMarker.current) clickMarker.current.remove()
        const el = document.createElement('div')
        el.style.cssText = 'width:18px;height:18px;border-radius:50%;border:2px solid #ffaa00;background:rgba(255,170,0,0.25);box-shadow:0 0 12px rgba(255,170,0,0.6);'
        clickMarker.current = new mgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(m)
        onLocationSelect({ id:`custom_${Date.now()}`, name:'Custom Location', lat:parseFloat(lat.toFixed(5)), lon:parseFloat(lng.toFixed(5)), platform:'sentinel-2-l2a', description:`${lat.toFixed(4)}°, ${lng.toFixed(4)}°`, isCustom:true })
      })
      mapRef.current = m
    }).catch(err => console.error('Mapbox init failed:', err))
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null } }
  }, [])

  // ── Style change ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return
    mapRef.current.setStyle(MAP_STYLES[mapStyle] || MAP_STYLES.satellite)
    mapRef.current.once('style.load', () => {
      mapRef.current.setFog({ color:'rgb(2,5,10)', 'high-color':'rgb(10,30,50)', 'horizon-blend':0.04, 'space-color':'rgb(5,7,9)', 'star-intensity':0.8 })
      if (scenesRef.current.length) {
        setTimeout(() => {
          drawFps(scenesRef.current, lastSceneRef.current?.id)
          if (lastSceneRef.current && lastRenderRef.current)
            addTiles(lastSceneRef.current, lastRenderRef.current, opacityRef.current)
        }, 600)
      }
    })
  }, [mapStyle])

  // ── Location markers ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || !locations.length) return
    import('mapbox-gl').then(({ default: mgl }) => {
      Object.values(markersRef.current).forEach(m => m.remove())
      markersRef.current = {}
      locations.forEach(loc => {
        const c = PLATFORM_COLORS[loc.platform] || '#00ff88'
        const el = document.createElement('div')
        el.style.cssText = `width:11px;height:11px;border-radius:50%;background:${c};border:1.5px solid rgba(255,255,255,0.4);cursor:pointer;box-shadow:0 0 8px ${c}88;transition:transform 0.2s;`
        el.addEventListener('mouseenter', () => { el.style.transform='scale(2)'; onHover?.(loc) })
        el.addEventListener('mouseleave', () => { el.style.transform='scale(1)'; onHover?.(null) })
        el.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); onLocationSelect(loc) })
        const popup = new mgl.Popup({ offset:14, closeButton:false, closeOnClick:false }).setHTML(`
          <div style="font-family:monospace;font-size:11px;min-width:170px;line-height:1.6">
            <div style="color:#00ff88;font-weight:bold;margin-bottom:3px">${loc.name}</div>
            <div style="color:#8bb0cc;font-size:10px;margin-bottom:2px">${loc.platform}</div>
            <div style="color:#4a6a84;font-size:10px">${loc.lat.toFixed(3)}°, ${loc.lon.toFixed(3)}°</div>
            <div style="color:#8bb0cc;font-size:10px;margin-top:4px;max-width:190px">${loc.description}</div>
          </div>`)
        el.addEventListener('mouseenter', () => popup.addTo(mapRef.current))
        el.addEventListener('mouseleave', () => popup.remove())
        markersRef.current[loc.id] = new mgl.Marker({ element:el }).setLngLat([loc.lon,loc.lat]).addTo(mapRef.current)
      })
    })
  }, [locations, mapLoaded])

  // ── Fly + search ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !mapLoaded || !selectedLocation) return
    Object.entries(markersRef.current).forEach(([id,m]) => {
      m.getElement().style.transform = id===selectedLocation.id ? 'scale(2.2)' : 'scale(1)'
    })
    mapRef.current.flyTo({ center:[selectedLocation.lon,selectedLocation.lat], zoom:8.5, duration:1800 })
    cfgRef.current = PLATFORM_TO_CFG[selectedLocation.platform] || RENDER_CFG['sentinel-2-l2a']
    setShowPanel(true); setSelScene(null); setSelRender(null)
    setScenes([]); setTileStatus(''); setMetaTab(null)
    clearAll()
    doSearch(selectedLocation)
  }, [selectedLocation, mapLoaded])

  // ── STAC search ──────────────────────────────────────────────────────────────
  const doSearch = async (loc) => {
    setSearching(true)
    const cfg = cfgRef.current
    const bbox = [loc.lon-0.9, loc.lat-0.9, loc.lon+0.9, loc.lat+0.9]
    const items = await fetchScenes(cfg.collection, bbox)
    setScenes(items); scenesRef.current = items
    setSearching(false)
    if (items.length > 0) {
      setTimeout(() => {
        drawFps(items, items[0].id)
        doSelectRef.current?.(items[0], cfg.renders[0])
      }, 300)
    }
  }

  // ── Clear layers ─────────────────────────────────────────────────────────────
  const clearAll = useCallback(() => {
    const m = mapRef.current; if (!m) return
    safeRm(m, [TILE_LYR, TILE_SRC])
    for (let i=0; i<fpCountRef.current; i++) safeRm(m, [`fp-f-${i}`,`fp-l-${i}`,`fp-s-${i}`])
    fpCountRef.current = 0
  }, [])

  // ── Draw footprints — ALL scenes, active one highlighted ─────────────────────
  const drawFps = useCallback((items, activeId) => {
    const m = mapRef.current; if (!m) return
    for (let i=0; i<fpCountRef.current; i++) safeRm(m, [`fp-f-${i}`,`fp-l-${i}`,`fp-s-${i}`])
    fpCountRef.current = items.length
    items.forEach((scene, i) => {
      if (!scene.geometry) return
      const active = scene.id === activeId
      try {
        m.addSource(`fp-s-${i}`, { type:'geojson', data:{ type:'Feature', geometry:scene.geometry, properties:{} } })
        // Fill — only visible for active scene
        m.addLayer({ id:`fp-f-${i}`, type:'fill', source:`fp-s-${i}`,
          paint:{ 'fill-color':'#2979ff', 'fill-opacity': active?0.08:0.01 } })
        // Outline — active = bright blue, inactive = dim
        m.addLayer({ id:`fp-l-${i}`, type:'line', source:`fp-s-${i}`,
          paint:{ 'line-color': active?'#2979ff':'#3a5a80', 'line-width': active?2:0.7, 'line-opacity': active?1:0.35 } })
        // Click footprint to select scene
        m.on('click',      `fp-f-${i}`, e => { e.preventDefault(); doSelectRef.current?.(scene, cfgRef.current.renders[0]) })
        m.on('mouseenter', `fp-f-${i}`, () => { m.getCanvas().style.cursor = 'pointer' })
        m.on('mouseleave', `fp-f-${i}`, () => { m.getCanvas().style.cursor = '' })
      } catch {}
    })
  }, [])

  // ── Add satellite tiles — 3-strategy cascade ────────────────────────────────
  // Strategy 1: rendered_preview/visual COG (always works, RGB pre-rendered)
  // Strategy 2: signed /item/tiles with per-band rescale + nodata=0
  // Strategy 3: unsigned /item/tiles (public collections)
  const addTiles = useCallback(async (scene, render, op) => {
    const m = mapRef.current; if (!m) return
    safeRm(m, [TILE_LYR, TILE_SRC])
    setTileLoading(true)
    setTileStatus('Signing item...')

    const col = cfgRef.current.collection

    // Step 1: Sign the item (gets SAS tokens on asset hrefs)
    const signedItem = await signItem(col, scene.id)

    // Build ordered list of URLs to try
    const urlsToTry = []

    const isRgbRender = ['natural','falsecolor','swir','vvvh'].includes(render.id)

    // Strategy 1: signed item tiles with correct per-band rescale (preferred)
    if (signedItem) {
      const signedUrl = buildSignedTileUrl(signedItem, render, col)
      urlsToTry.push({ url: signedUrl, label: 'signed item tiles' })
    }

    // Strategy 2: unsigned item tiles
    const unsignedUrl = buildSignedTileUrl(scene, render, col)
    urlsToTry.push({ url: unsignedUrl, label: 'unsigned item tiles' })

    // Strategy 3: rendered_preview/visual COG — only for RGB renders as last resort
    if (isRgbRender) {
      const previewUrl = buildRenderedPreviewUrl(signedItem || scene)
      if (previewUrl) urlsToTry.push({ url: previewUrl, label: 'preview COG' })
    }

    console.log('[PC] tile strategies:', urlsToTry.map(u => u.label))

    // Try each URL in sequence until one works
    let urlIdx = 0
    const tryNext = () => {
      if (urlIdx >= urlsToTry.length) {
        setTileLoading(false)
        setTileStatus('⚠ No tiles available for this scene')
        return
      }
      const { url, label } = urlsToTry[urlIdx++]
      console.log(`[PC] trying ${label}:`, url)
      setTileStatus(`Loading ${label}...`)

      safeRm(m, [TILE_LYR, TILE_SRC])
      if (!mapRef.current) return

      try {
        m.addSource(TILE_SRC, {
          type: 'raster',
          tiles: [url],
          tileSize: 256,
          attribution: '© Microsoft Planetary Computer',
          minzoom: 4, maxzoom: 18,
          bounds: scene.bbox || undefined,
        })
        // Insert tile layer BELOW footprint lines so footprints stay on top
        const firstFpLayer = mapRef.current?.getLayer('fp-f-0') ? 'fp-f-0' : undefined
        m.addLayer({
          id: TILE_LYR, type: 'raster', source: TILE_SRC,
          paint: {
            'raster-opacity': op / 100,
            'raster-resampling': 'linear',
            'raster-fade-duration': 400,
            'raster-saturation': 0.15,      // slight boost so colours pop
            'raster-contrast': 0.05,        // very slight contrast lift
            'raster-brightness-min': 0.0,
          },
        }, firstFpLayer)

        let resolved = false
        const succeed = () => {
          if (resolved) return; resolved = true
          setTileLoading(false); setTileStatus('')
          console.log(`[PC] ✓ ${label} loaded`)
        }
        const fail = (reason) => {
          if (resolved) return; resolved = true
          console.warn(`[PC] ✗ ${label} failed:`, reason)
          tryNext()  // try next strategy
        }

        // Success: map fires 'data' with isSourceLoaded=true
        const dataHandler = (e) => {
          if (e.sourceId === TILE_SRC && e.isSourceLoaded) {
            m.off('data', dataHandler)
            m.off('error', errHandler)
            succeed()
          }
        }
        const errHandler = (e) => {
          if (e.sourceId !== TILE_SRC) return
          m.off('data', dataHandler)
          m.off('error', errHandler)
          fail(e.error?.status || e.error?.message || 'unknown')
        }
        m.on('data', dataHandler)
        m.on('error', errHandler)

        // Timeout — if no data event in 8s, try next
        setTimeout(() => fail('timeout'), 8000)

      } catch (err) {
        console.warn('[PC] source/layer error:', err)
        tryNext()
      }
    }

    tryNext()
  }, [])

  // ── Download scene thumbnail ──────────────────────────────────────────────────
  const downloadScene = useCallback(async (scene, render) => {
    setDownloading(true)
    try {
      // Try thumbnail first (always available, no auth)
      const thumbUrl = getThumbnailUrl(scene)
      if (thumbUrl) {
        const a = document.createElement('a')
        a.href = thumbUrl
        a.download = `${scene.id}_thumbnail.jpg`
        a.target = '_blank'
        document.body.appendChild(a); a.click(); document.body.removeChild(a)
        setDownloading(false)
        return
      }
      // Fallback: open the PC Explorer page for this scene
      window.open(`https://planetarycomputer.microsoft.com/catalog/${cfgRef.current.collection}`, '_blank')
    } catch (err) {
      console.warn('download error:', err)
    }
    setDownloading(false)
  }, [])

  // ── Select scene ─────────────────────────────────────────────────────────────
  const doSelect = useCallback((scene, render) => {
    const r = render || cfgRef.current.renders[0]
    setSelScene(scene); setSelRender(r); setMetaTab(null)
    lastSceneRef.current = scene; lastRenderRef.current = r
    drawFps(scenesRef.current, scene.id)
    addTiles(scene, r, opacityRef.current)

    // ← Notify App.jsx → ControlPanel with the real item ID + collection
    onSceneSelect?.({
      id:         scene.id,
      collection: cfgRef.current.collection,
      datetime:   scene.properties?.datetime,
      cloud:      scene.properties?.['eo:cloud_cover'],
      bbox:       scene.bbox,
    })

    if (scene.bbox && mapRef.current) {
      const [w,s,e,n] = scene.bbox
      mapRef.current.fitBounds([[w,s],[e,n]], { padding:60, duration:1200, maxZoom:10 })
    }
  }, [drawFps, addTiles, onSceneSelect])

  useEffect(() => { doSelectRef.current = doSelect }, [doSelect])

  // ── Opacity live ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !selScene) return
    try { mapRef.current.setPaintProperty(TILE_LYR, 'raster-opacity', opacity/100) } catch {}
  }, [opacity, selScene])

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const fmtD = dt => !dt?'—':new Date(dt).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
  const fmtT = dt => !dt?'':new Date(dt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})+' UTC'
  const cld  = s => s.properties?.['eo:cloud_cover']
  const thb  = s => getThumbnailUrl(s)
  const cfg  = selectedLocation ? (PLATFORM_TO_CFG[selectedLocation.platform]||RENDER_CFG['sentinel-2-l2a']) : RENDER_CFG['sentinel-2-l2a']

  return (
    <div style={{ position:'relative', flex:1, overflow:'hidden', display:'flex' }}>

      {/* PC Explorer Panel */}
      {showPanel && selectedLocation && (
        <div style={{ width:310, flexShrink:0, background:'rgba(5,8,16,0.97)', borderRight:'1px solid var(--border)', display:'flex', flexDirection:'column', overflow:'hidden', zIndex:10 }}>

          {/* Header */}
          <div style={{ padding:'12px 14px 10px', borderBottom:'1px solid var(--border)', flexShrink:0 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
              <div>
                <div style={{ fontFamily:'var(--mono)', fontSize:8, color:'var(--text3)', letterSpacing:2.5, marginBottom:4 }}>PLANETARY COMPUTER</div>
                <div style={{ fontFamily:'var(--mono)', fontSize:12, color:'var(--text)', fontWeight:700 }}>Explore Datasets</div>
              </div>
              <button onClick={() => { setShowPanel(false); clearAll(); setSelScene(null); setTileStatus('') }}
                style={{ background:'none', border:'none', color:'var(--text3)', cursor:'pointer', fontSize:18, lineHeight:1, padding:'0 4px' }}>×</button>
            </div>

            {/* Collection */}
            <div style={{ display:'flex', alignItems:'center', gap:7, padding:'6px 10px', background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:4, marginBottom:10 }}>
              <div style={{ width:7, height:7, borderRadius:'50%', background:PLATFORM_COLORS[selectedLocation.platform]||'#00ff88', boxShadow:`0 0 6px ${PLATFORM_COLORS[selectedLocation.platform]||'#00ff88'}` }} />
              <span style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--text)' }}>{cfg.collection}</span>
            </div>

            {/* Render buttons */}
            <div>
              <div style={{ fontFamily:'var(--mono)', fontSize:8, color:'var(--text3)', letterSpacing:2, marginBottom:6 }}>RENDER</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                {cfg.renders.map(r => {
                  const act = selRender?.id === r.id
                  return (
                    <button key={r.id}
                      onClick={() => { setSelRender(r); if(selScene) { lastRenderRef.current=r; addTiles(selScene,r,opacityRef.current) } }}
                      style={{ padding:'4px 10px', borderRadius:4, cursor:'pointer', fontFamily:'var(--mono)', fontSize:9, background:act?r.color+'22':'var(--surface2)', border:`1px solid ${act?r.color:'var(--border)'}`, color:act?r.color:'var(--text3)', transition:'all .15s' }}>
                      {r.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Scene count */}
          <div style={{ padding:'7px 14px 5px', borderBottom:'1px solid var(--border)', flexShrink:0, display:'flex', justifyContent:'space-between' }}>
            <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)' }}>{searching?'Searching...':`${scenes.length} scene${scenes.length!==1?'s':''} found`}</span>
            <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)' }}>Most recent · low cloud</span>
          </div>

          {/* Tile status bar */}
          {tileStatus && (
            <div style={{ padding:'5px 14px', background: tileStatus.startsWith('⚠')?'rgba(255,68,85,0.1)':'rgba(41,121,255,0.08)', borderBottom:'1px solid var(--border)', fontFamily:'var(--mono)', fontSize:9, color: tileStatus.startsWith('⚠')?'#ff5252':'#82b1ff', display:'flex', alignItems:'center', gap:6 }}>
              {tileLoading && <div style={{ width:8, height:8, border:'1.5px solid #82b1ff', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite', flexShrink:0 }} />}
              {tileStatus}
            </div>
          )}

          {/* Scene list */}
          <div style={{ flex:1, overflowY:'auto' }}>
            {searching && (
              <div style={{ padding:'32px 14px', display:'flex', flexDirection:'column', alignItems:'center', gap:10 }}>
                <div style={{ width:24, height:24, border:'2px solid var(--border)', borderTopColor:'#2979ff', borderRadius:'50%', animation:'spin 1s linear infinite' }} />
                <div style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--text3)' }}>Searching Planetary Computer...</div>
              </div>
            )}
            {!searching && scenes.length===0 && (
              <div style={{ padding:'28px 14px', fontFamily:'var(--mono)', fontSize:10, color:'var(--text3)', textAlign:'center', lineHeight:1.8 }}>No scenes found.<br/>Try a different location.</div>
            )}
            {!searching && scenes.map((scene) => {
              const isSel = selScene?.id === scene.id
              const cl    = cld(scene)
              const th    = thb(scene)
              const dt    = scene.properties?.datetime
              return (
                <div key={scene.id} style={{ borderBottom:'1px solid var(--border)', borderLeft:`3px solid ${isSel?'#2979ff':'transparent'}`, background:isSel?'rgba(41,121,255,0.1)':'transparent', transition:'background .15s' }}>
                  {/* Row — click to select + zoom to AOI */}
                  <div onClick={() => doSelect(scene, selRender||cfg.renders[0])}
                    style={{ display:'flex', gap:10, padding:'10px 14px', cursor:'pointer', alignItems:'flex-start' }}
                    onMouseEnter={e => { if(!isSel) e.currentTarget.style.background='rgba(255,255,255,0.03)' }}
                    onMouseLeave={e => { if(!isSel) e.currentTarget.style.background='transparent' }}>
                    {/* Thumbnail */}
                    <div style={{ width:58, height:58, flexShrink:0, borderRadius:4, overflow:'hidden', background:'#090e1a', border:`1px solid ${isSel?'#2979ff':'var(--border)'}`, display:'flex', alignItems:'center', justifyContent:'center', position:'relative' }}>
                      {th
                        ? <img src={th} alt="" style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} onError={e=>e.target.style.display='none'} />
                        : <span style={{ fontFamily:'var(--mono)', fontSize:8, color:'var(--text3)' }}>NO PREV</span>
                      }
                    </div>
                    {/* Info */}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontFamily:'var(--mono)', fontSize:10, color:isSel?'#82b1ff':'var(--text)', marginBottom:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{scene.id}</div>
                      <div style={{ fontFamily:'var(--mono)', fontSize:10, color:'var(--text2)', marginBottom:1 }}>{fmtD(dt)}</div>
                      <div style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)', marginBottom:5 }}>{fmtT(dt)}</div>
                      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                        {cl!=null && <span style={{ fontFamily:'var(--mono)', fontSize:9, color:cl<5?'#00e676':cl<20?'#ffaa00':'#ff5252' }}>☁ {cl.toFixed(1)}%</span>}
                        {isSel && <span style={{ fontFamily:'var(--mono)', fontSize:9, padding:'1px 7px', borderRadius:3, background:tileLoading?'rgba(255,145,0,0.15)':'rgba(41,121,255,0.2)', color:tileLoading?'#ffaa00':'#82b1ff', border:`1px solid ${tileLoading?'rgba(255,145,0,0.4)':'rgba(41,121,255,0.4)'}` }}>{tileLoading?'⟳ loading':'● active'}</span>}
                      </div>
                    </div>
                    {/* Download button — always visible on selected scene */}
                    {isSel && (
                      <button
                        onClick={e => { e.stopPropagation(); downloadScene(scene, selRender) }}
                        title="Download thumbnail"
                        style={{ flexShrink:0, padding:'4px 7px', borderRadius:4, background:'rgba(0,255,136,0.1)', border:'1px solid rgba(0,255,136,0.3)', color:'#00e676', cursor:'pointer', fontFamily:'var(--mono)', fontSize:11, alignSelf:'center' }}>
                        {downloading ? '⟳' : '⬇'}
                      </button>
                    )}
                  </div>

                  {/* Metadata expand (only for selected scene) */}
                  {isSel && (
                    <div style={{ padding:'0 14px 10px' }}>
                      <div style={{ display:'flex', borderBottom:'1px solid var(--border)', marginBottom:8 }}>
                        {['Metadata','Assets'].map(tab => (
                          <button key={tab} onClick={() => setMetaTab(metaTab===tab?null:tab)}
                            style={{ padding:'5px 12px', background:'none', border:'none', borderBottom:`2px solid ${metaTab===tab?'#2979ff':'transparent'}`, fontFamily:'var(--mono)', fontSize:9, color:metaTab===tab?'#82b1ff':'var(--text3)', cursor:'pointer', letterSpacing:1 }}>
                            {tab}
                          </button>
                        ))}
                        {/* Open in PC Explorer */}
                        <a href={`https://planetarycomputer.microsoft.com/catalog/${cfg.collection}`} target="_blank" rel="noreferrer"
                          style={{ marginLeft:'auto', padding:'5px 10px', fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)', textDecoration:'none', display:'flex', alignItems:'center', gap:4 }}
                          onClick={e => e.stopPropagation()}>
                          ↗ PC
                        </a>
                      </div>
                      {metaTab==='Metadata' && (
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'4px 12px', fontFamily:'var(--mono)', fontSize:9 }}>
                          {[
                            ['GSD',      scene.properties?.gsd ? `${scene.properties.gsd} m` : '—'],
                            ['Platform', scene.properties?.platform||'—'],
                            ['Date',     fmtD(dt)],
                            ['Cloud',    cl!=null?`${cl.toFixed(1)}%`:'—'],
                            ['Created',  scene.properties?.created?.slice(0,10)||'—'],
                            ['Level',    scene.properties?.['processing:level']||'L2'],
                          ].map(([l,v]) => (
                            <div key={l} style={{ marginBottom:3 }}>
                              <div style={{ color:'var(--text3)', marginBottom:1 }}>{l}</div>
                              <div style={{ color:'var(--text2)' }}>{v}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {metaTab==='Assets' && (
                        <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
                          {Object.entries(scene.assets||{}).slice(0,10).map(([k,a]) => (
                            <div key={k} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'3px 6px', background:'var(--surface2)', borderRadius:3 }}>
                              <span style={{ fontFamily:'var(--mono)', fontSize:9, color:'var(--text2)' }}>{k}</span>
                              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                                <span style={{ fontFamily:'var(--mono)', fontSize:8, color:'var(--text3)' }}>{a.type?.split('/').pop()||'—'}</span>
                                {a.href && (
                                  <a href={a.href} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()}
                                    style={{ fontFamily:'var(--mono)', fontSize:9, color:'#00e676', textDecoration:'none' }}>⬇</a>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Opacity + footer */}
          {selScene && (
            <div style={{ padding:'10px 14px', borderTop:'1px solid var(--border)', flexShrink:0, background:'rgba(5,8,16,0.98)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                <span style={{ fontFamily:'var(--mono)', fontSize:8, color:'var(--text3)', letterSpacing:1.5 }}>LAYER OPACITY</span>
                <span style={{ fontFamily:'var(--mono)', fontSize:10, color:'#82b1ff' }}>{opacity}%</span>
              </div>
              <input type="range" min="10" max="100" value={opacity} onChange={e=>setOpacity(+e.target.value)} style={{ width:'100%', accentColor:'#2979ff' }} />
              {/* Download full scene */}
              <div style={{ marginTop:8, display:'flex', gap:6 }}>
                <button onClick={() => downloadScene(selScene, selRender)}
                  style={{ flex:1, padding:'5px 0', borderRadius:4, background:'rgba(0,255,136,0.1)', border:'1px solid rgba(0,255,136,0.3)', color:'#00e676', cursor:'pointer', fontFamily:'var(--mono)', fontSize:9, letterSpacing:1 }}>
                  ⬇ DOWNLOAD THUMBNAIL
                </button>
                <a href={`https://planetarycomputer.microsoft.com/catalog/${cfg.collection}`} target="_blank" rel="noreferrer"
                  style={{ padding:'5px 10px', borderRadius:4, background:'var(--surface2)', border:'1px solid var(--border)', color:'var(--text3)', fontFamily:'var(--mono)', fontSize:9, textDecoration:'none', display:'flex', alignItems:'center' }}>
                  PC ↗
                </a>
              </div>
              <div style={{ marginTop:7, fontFamily:'var(--mono)', fontSize:9, color:'var(--text3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{selScene.id}</div>
            </div>
          )}
        </div>
      )}

      {/* Map */}
      <div style={{ flex:1, position:'relative' }}>
        <div ref={mapContainer} style={{ width:'100%', height:'100%' }} />

        {clickCoords && (
          <div style={{ position:'absolute', top:12, left:12, background:'rgba(5,7,9,.92)', border:'1px solid var(--border)', borderRadius:4, padding:'6px 12px', backdropFilter:'blur(8px)' }}>
            <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:2, marginBottom:3 }}>CUSTOM POINT</div>
            <div style={{ fontSize:12, color:'var(--orange)', fontFamily:'var(--mono)' }}>{clickCoords.lat}° N, {clickCoords.lon}° E</div>
          </div>
        )}

        {!showPanel && selectedLocation && (
          <button onClick={() => { setShowPanel(true); if(!scenes.length) doSearch(selectedLocation) }}
            style={{ position:'absolute', top:12, left:12, padding:'6px 14px', borderRadius:4, background:'rgba(5,7,9,.92)', border:`1px solid ${selScene?'#2979ff':'var(--border2)'}`, fontFamily:'var(--mono)', fontSize:10, color:selScene?'#82b1ff':'var(--text2)', cursor:'pointer', backdropFilter:'blur(8px)', display:'flex', alignItems:'center', gap:7 }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:selScene?'#00e676':'var(--border2)' }} />
            PC EXPLORER {selScene?'●':'○'}
          </button>
        )}

        {selScene && (
          <div style={{ position:'absolute', bottom:50, left:'50%', transform:'translateX(-50%)', background:'rgba(5,7,9,.90)', border:`1px solid ${tileLoading?'rgba(255,170,0,0.5)':'#2979ff'}`, borderRadius:4, padding:'5px 16px', backdropFilter:'blur(8px)', fontFamily:'var(--mono)', fontSize:10, color:tileLoading?'#ffaa00':'#82b1ff', display:'flex', alignItems:'center', gap:8, whiteSpace:'nowrap' }}>
            {tileLoading
              ? <><div style={{ width:10, height:10, border:'1.5px solid #ffaa00', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} /> {tileStatus||'Loading...'}</>
              : <><div style={{ width:6, height:6, borderRadius:'50%', background:'#00e676' }} /> {selRender?.label} · {fmtD(selScene.properties?.datetime)}</>
            }
          </div>
        )}

        <div style={{ position:'absolute', bottom:40, right:12, background:'rgba(5,7,9,.88)', border:'1px solid var(--border)', borderRadius:4, padding:'10px 12px', backdropFilter:'blur(8px)' }}>
          <div style={{ fontSize:9, color:'var(--text3)', letterSpacing:2, marginBottom:8 }}>PLATFORMS</div>
          {Object.entries(PLATFORM_COLORS).slice(0,5).map(([p,c]) => (
            <div key={p} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
              <div style={{ width:7, height:7, borderRadius:'50%', background:c, boxShadow:`0 0 5px ${c}88` }} />
              <span style={{ fontSize:9, color:'var(--text2)', fontFamily:'var(--mono)' }}>{p.split('-')[0].toUpperCase()}</span>
            </div>
          ))}
        </div>

        {!selectedLocation && (
          <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', pointerEvents:'none', textAlign:'center', animation:'fade-in 1s ease 1s both' }}>
            <div style={{ fontSize:11, color:'rgba(139,176,204,0.4)', letterSpacing:2, fontFamily:'var(--mono)' }}>CLICK MAP OR SELECT A LOCATION →</div>
          </div>
        )}
      </div>
    </div>
  )
}