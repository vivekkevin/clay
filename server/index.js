/**
 * Clay Foundation Model — Web Server
 * ====================================
 * Spawns clay_pipeline.py for real model inference.
 * Streams progress via WebSocket to the frontend.
 */

const express    = require('express')
const cors       = require('cors')
const fileUpload = require('express-fileupload')
const { v4: uuidv4 } = require('uuid')
const http       = require('http')
const WebSocket  = require('ws')
const path       = require('path')
const fs         = require('fs')
const { spawn }  = require('child_process')

const app    = express()
const server = http.createServer(app)
const wss    = new WebSocket.Server({ server })

app.use(cors({ origin: '*' }))
app.use(express.json())
app.use(fileUpload({ createParentPath: true, limits: { fileSize: 500 * 1024 * 1024 } }))

// ── WebSocket: jobId → ws ─────────────────────────────────────────────────────
const jobClients = new Map()

wss.on('connection', (ws, req) => {
  const jobId = new URL(req.url, 'ws://localhost').searchParams.get('jobId')
  if (jobId) {
    jobClients.set(jobId, ws)
    ws.on('close', () => jobClients.delete(jobId))
  }
})

function sendWS(jobId, obj) {
  const ws = jobClients.get(jobId)
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(obj))
}

// ── In-memory job store ───────────────────────────────────────────────────────
const jobs = new Map()

// ── Python detection — finds the real Python executable ──────────────────────
const { execFileSync } = require('child_process')

function findPython() {
  // If user set PYTHON_PATH env var, use it directly
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH

  const isWin = process.platform === 'win32'

  // Candidates in priority order
  const candidates = isWin
    ? [
        // Project venv first — highest priority
        path.join(__dirname, '..', 'clay_env', 'Scripts', 'python.exe'),
        path.join(__dirname, '..', 'venv',     'Scripts', 'python.exe'),
        path.join(__dirname, '..', '.venv',    'Scripts', 'python.exe'),
        // C:\Clay\clay_env (absolute, matches your setup)
        'C:\\Clay\\clay_env\\Scripts\\python.exe',
        // Windows PATH
        'python',
        'python3',
        // Common install locations
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python39',  'python.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python38',  'python.exe'),
        'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe', 'C:\\Python39\\python.exe',
        // Anaconda / Miniconda
        path.join(process.env.USERPROFILE || '', 'anaconda3',  'python.exe'),
        path.join(process.env.USERPROFILE || '', 'miniconda3', 'python.exe'),
        path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'anaconda3',  'python.exe'),
        path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'miniconda3', 'python.exe'),
      ]
    : [
        'python3',
        'python',
        // venv inside project
        path.join(__dirname, '..', 'venv', 'bin', 'python3'),
        path.join(__dirname, '..', '.venv', 'bin', 'python3'),
        // Homebrew macOS
        '/usr/local/bin/python3',
        '/opt/homebrew/bin/python3',
        // Linux system
        '/usr/bin/python3',
        '/usr/local/bin/python3',
      ]

  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd, ['--version'], { timeout: 3000, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })
      console.log(`[Python] Found: ${cmd}  →  ${out.trim()}`)
      return cmd
    } catch { /* not found, try next */ }
  }

  // Last resort
  console.warn('[Python] Could not auto-detect Python. Set PYTHON_PATH env var.')
  return isWin ? 'python' : 'python3'
}

const PYTHON_CMD = findPython()
const PIPELINE   = path.join(__dirname, 'clay_pipeline.py')

// Check if Python pipeline is available
function pipelineAvailable() {
  return fs.existsSync(PIPELINE)
}

// ── Biome detection (used for fallback display names) ─────────────────────────
function getBiome(lat, lon) {
  if ((lat>13&&lat<36&&lon>-18&&lon<60)||(lat>20&&lat<50&&lon>55&&lon<105)) return 'desert'
  if (lat>-15&&lat<15&&((lon>-80&&lon<-35)||(lon>8&&lon<45)||(lon>95&&lon<145))) return 'tropical'
  if (lat>65||lat<-60) return 'arctic'
  if ((lat>-25&&lat<13&&lon>-18&&lon<50)) return 'savanna'
  return 'temperate'
}

// ── Sample locations ──────────────────────────────────────────────────────────
const SAMPLE_LOCATIONS = [
  { id:'amazon',        name:'Amazon Rainforest',     lat:-3.4653,  lon:-62.2159, platform:'sentinel-2-l2a',  description:'Dense tropical rainforest' },
  { id:'sahara',        name:'Sahara Desert',          lat:23.4162,  lon:25.6628,  platform:'sentinel-2-l2a',  description:'Vast arid landscape' },
  { id:'himalayas',     name:'Himalayan Glaciers',     lat:28.2180,  lon:85.5136,  platform:'sentinel-2-l2a',  description:'High-altitude glaciers' },
  { id:'ganges',        name:'Ganges Delta',           lat:22.3511,  lon:89.8617,  platform:'sentinel-2-l2a',  description:'World\'s largest river delta' },
  { id:'california',    name:'California Agriculture', lat:36.7783,  lon:-119.4179,platform:'naip',            description:'Central Valley agriculture' },
  { id:'nile',          name:'Nile Delta',             lat:30.9676,  lon:30.9019,  platform:'sentinel-2-l2a',  description:'Nile meets the Mediterranean' },
  { id:'arctic',        name:'Arctic Sea Ice',         lat:78.2232,  lon:15.6267,  platform:'sentinel-1-rtc',  description:'Polar SAR imagery' },
  { id:'amazon_defor',  name:'Amazon Deforestation',   lat:-11.8875, lon:-55.4696, platform:'landsat-c2l2-sr', description:'Deforestation frontier' },
  { id:'mekong',        name:'Mekong Delta',           lat:10.0452,  lon:105.7469, platform:'sentinel-2-l2a',  description:'Southeast Asia rice bowl' },
  { id:'great_barrier', name:'Great Barrier Reef',     lat:-18.2871, lon:147.6992, platform:'sentinel-2-l2a',  description:'World\'s largest coral reef' },
  { id:'bangkok',       name:'Bangkok Expansion',      lat:13.7563,  lon:100.5018, platform:'sentinel-2-l2a',  description:'Rapid urban expansion' },
]

// ── Run a job by spawning clay_pipeline.py ────────────────────────────────────
async function runJob(jobId) {
  const job = jobs.get(jobId)
  if (!job) return

  job.status  = 'running'
  job.started = Date.now()

  const log = (msg, type = 'log') => {
    job.logs.push({ ts: Date.now(), msg })
    sendWS(jobId, { type, msg, ts: Date.now() })
  }

  // ── Check if Python pipeline exists ───────────────────────────────────────
  if (!pipelineAvailable()) {
    log('clay_pipeline.py not found — install Python dependencies first', 'error')
    log('Run: pip install torch torchvision planetary-computer pystac-client rasterio scikit-learn einops pyyaml python-box', 'log')
    job.status = 'failed'
    job.error  = 'Pipeline not available'
    return
  }

  const { task, params } = job

  // ── Resolve checkpoint path ───────────────────────────────────────────────
  const DEFAULT_CKPT_PATHS = [
    'C:\\Clay\\clay-web-new\\checkpoints\\clay-v1.5.ckpt',  // confirmed location
    './checkpoints/clay-v1.5.ckpt',
    'C:\\Clay\\checkpoints\\clay-v1.5.ckpt',
    'C:\\Clay\\clay-v1.5.ckpt',
    path.join(__dirname, '..', 'checkpoints', 'clay-v1.5.ckpt'),
    path.join(__dirname, '..', 'clay-v1.5.ckpt'),
  ]
  let resolvedCkpt = params.checkpoint || ''
  if (!resolvedCkpt || !fs.existsSync(resolvedCkpt)) {
    for (const c of DEFAULT_CKPT_PATHS) {
      if (fs.existsSync(c)) { resolvedCkpt = c; break }
    }
  }
  if (resolvedCkpt) log(`Using checkpoint: ${resolvedCkpt}`, 'log')
  else              log('No checkpoint found — demo mode (random weights)', 'log')

  // ── Warn if no scene item selected ───────────────────────────────────────
  const itemId = params.item || params.itemId || ''
  if (!itemId) {
    log('ERROR: No scene selected. Go to the PC Explorer panel on the map, click a scene row to activate it, then click RUN.', 'error')
    job.status = 'failed'
    job.error  = 'No scene selected'
    return
  }

  // Build CLI args for clay_pipeline.py
  const args = [
    PIPELINE,
    '--task',        task,
    '--collection',  params.collection || params.platform || 'sentinel-2-l2a',
    '--item',        itemId,
    '--lat',         String(params.lat  || 0),
    '--lon',         String(params.lon  || 0),
    '--model_size',  params.model_size || params.modelSize || 'base',
    '--checkpoint',  resolvedCkpt,
    '--job_id',      jobId,
  ]

  if (task === 'landcover') {
    args.push('--epochs',      String(params.epochs      || 5))
    args.push('--batch_size',  String(params.batch_size  || 4))
    args.push('--lr',          String(params.lr          || 0.001))
    args.push('--num_classes', String(params.num_classes || 10))
  }
  if (task === 'inference') {
    args.push('--mask_ratio', String(params.mask_ratio || 0.75))
  }
  if (task === 'cloudremoval') {
    args.push('--cloud_fraction', String(params.cloud_fraction || 0.4))
  }

  log(`Starting Clay pipeline: ${task}`)
  log(`Platform: ${params.collection || params.platform}`)
  log(`Item: ${params.item || params.itemId || '(no item — using synthetic)'}`)
  log(`Location: (${params.lat}, ${params.lon})`)
  log(`Command: ${PYTHON_CMD} ${args.slice(1,3).join(' ')} ...`)

  const proc = spawn(PYTHON_CMD, args, {
    cwd: __dirname,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })

  job.pid = proc.pid

  let buffer = ''

  proc.stdout.on('data', chunk => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // Try to parse as JSON (our pipeline emits JSON lines)
      try {
        const obj = JSON.parse(trimmed)

        if (obj.type === 'log') {
          log(obj.msg, 'log')
        } else if (obj.type === 'progress') {
          job.logs.push({ ts: Date.now(), msg: obj.msg })
          sendWS(jobId, {
            type:    'progress',
            msg:     obj.msg,
            epoch:   obj.epoch,
            loss:    obj.loss,
            acc:     obj.acc,
            ts:      obj.ts || Date.now(),
          })
        } else if (obj.type === 'completed_location') {
          // Pipeline finished — forward red marker event to frontend
          sendWS(jobId, {
            type:    'completed_location',
            lat:     obj.lat,
            lon:     obj.lon,
            item_id: obj.item_id,
            task:    obj.task,
            label:   obj.label,
            jobId,
          })
        } else if (obj.type === 'result') {
          job.result    = { ...obj.data, biome: getBiome(params.lat||0, params.lon||0) }
          job.status    = 'completed'
          job.completed = Date.now()
          sendWS(jobId, {
            type:   'result',
            result: job.result,
            jobId,
          })
          log(`Analysis complete in ${((Date.now() - job.started)/1000).toFixed(1)}s`, 'complete')
        } else if (obj.type === 'error') {
          log(`ERROR: ${obj.msg}`, 'error')
          job.status = 'failed'
          job.error  = obj.msg
        }
      } catch {
        // Not JSON — plain text log from Python
        log(trimmed, 'log')
      }
    }
  })

  proc.stderr.on('data', chunk => {
    const msg = chunk.toString().trim()
    if (msg) {
      // Filter out harmless warnings
      if (msg.includes('UserWarning') || msg.includes('FutureWarning') ||
          msg.includes('DeprecationWarning') || msg.includes('torch.') ||
          msg.includes('warnings.warn')) return
      log(`[stderr] ${msg}`, 'log')
    }
  })

  proc.on('close', code => {
    if (job.status === 'running') {
      if (code === 0) {
        job.status    = 'completed'
        job.completed = Date.now()
        log('Pipeline process exited successfully', 'complete')
      } else {
        job.status = 'failed'
        job.error  = `Process exited with code ${code}`
        log(`Pipeline failed (exit code ${code})`, 'error')
      }
    }
  })

  proc.on('error', err => {
    log(`Failed to start Python: ${err.message}. Check PYTHON_PATH env or install Python.`, 'error')
    job.status = 'failed'
    job.error  = err.message
  })
}

// ── API Routes ────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    ts:     Date.now(),
    pipeline: pipelineAvailable(),
    python:   PYTHON_CMD,
  })
})

app.get('/api/locations', (req, res) => res.json({ locations: SAMPLE_LOCATIONS }))

app.get('/api/locations/:id', (req, res) => {
  const loc = SAMPLE_LOCATIONS.find(l => l.id === req.params.id)
  if (!loc) return res.status(404).json({ error: 'Not found' })
  res.json(loc)
})

// Submit a job — now uses real Python pipeline
app.post('/api/jobs', (req, res) => {
  const jobId      = uuidv4()
  const { task, params } = req.body

  if (!task || !params)
    return res.status(400).json({ error: 'task and params required' })

  jobs.set(jobId, {
    id:        jobId,
    status:    'queued',
    task,
    params,
    result:    null,
    logs:      [],
    created:   Date.now(),
    started:   null,
    completed: null,
    pid:       null,
  })

  res.json({ jobId, status: 'queued' })
  setTimeout(() => runJob(jobId), 50)
})

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  if (!job) return res.status(404).json({ error: 'Job not found' })
  res.json({
    id: job.id, status: job.status, task: job.task,
    params: job.params, result: job.result, logs: job.logs,
    created: job.created, started: job.started,
    completed: job.completed, error: job.error,
  })
})

app.get('/api/jobs', (req, res) => {
  const list = Array.from(jobs.values()).map(j => ({
    id: j.id, status: j.status, task: j.task,
    created: j.created, completed: j.completed,
    platform: j.params?.platform, lat: j.params?.lat, lon: j.params?.lon,
  }))
  res.json({ jobs: list.reverse() })
})

app.delete('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id)
  // Kill process if running
  if (job?.pid) {
    try { process.kill(job.pid) } catch {}
  }
  jobs.delete(req.params.id)
  res.json({ ok: true })
})

app.get('/api/platforms', (req, res) => {
  res.json({ platforms: [
    { id:'sentinel-2-l2a',  name:'Sentinel-2 L2A',   bands:10, gsd:10,  satellite:'ESA Sentinel-2' },
    { id:'sentinel-1-rtc',  name:'Sentinel-1 RTC',   bands:2,  gsd:10,  satellite:'ESA Sentinel-1' },
    { id:'landsat-c2l1',    name:'Landsat C2L1',     bands:6,  gsd:30,  satellite:'USGS Landsat 8/9' },
    { id:'landsat-c2l2-sr', name:'Landsat C2L2 SR',  bands:6,  gsd:30,  satellite:'USGS Landsat 8/9' },
    { id:'naip',            name:'NAIP',             bands:4,  gsd:1,   satellite:'USDA NAIP' },
  ]})
})

// AOI endpoint
app.post('/api/aoi', (req, res) => {
  const { geojson } = req.body
  if (!geojson) return res.status(400).json({ error: 'GeoJSON required' })

  const coords = []
  const harvest = (obj) => {
    if (!obj) return
    if (obj.type === 'FeatureCollection') obj.features?.forEach(harvest)
    else if (obj.type === 'Feature') harvest(obj.geometry)
    else if (obj.type === 'Polygon')
      obj.coordinates?.forEach(ring => ring.forEach(pt => coords.push(pt)))
    else if (obj.type === 'MultiPolygon')
      obj.coordinates?.forEach(p => p.forEach(r => r.forEach(pt => coords.push(pt))))
    else if (obj.type === 'Point') coords.push(obj.coordinates)
  }
  harvest(geojson)

  if (!coords.length) return res.status(400).json({ error: 'No coordinates found' })
  const lons = coords.map(c => c[0]), lats = coords.map(c => c[1])
  const bbox = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
  res.json({ bbox, center: [(bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2], coordinateCount: coords.length })
})

// Biome endpoint
app.get('/api/biome', (req, res) => {
  const lat = parseFloat(req.query.lat) || 0
  const lon = parseFloat(req.query.lon) || 0
  res.json({ biome: getBiome(lat, lon) })
})

// Pipeline status
app.get('/api/pipeline/status', (req, res) => {
  let pyVersion = 'unknown'
  try {
    pyVersion = execFileSync(PYTHON_CMD, ['--version'], { timeout:3000, encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim()
  } catch {}
  res.json({
    available:  pipelineAvailable(),
    python:     PYTHON_CMD,
    pyVersion,
    script:     PIPELINE,
    exists:     pipelineAvailable(),
    platform:   process.platform,
  })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`\nClay API server running on http://localhost:${PORT}`)
  console.log(`Python command: ${PYTHON_CMD}`)
  console.log(`Pipeline script: ${PIPELINE}`)
  console.log(`Pipeline available: ${pipelineAvailable()}`)
  if (!pipelineAvailable()) {
    console.log('\n[WARN] clay_pipeline.py not found.')
    console.log('[WARN] Place clay_pipeline.py in the server/ folder.')
    console.log('[WARN] Install dependencies: pip install torch torchvision planetary-computer pystac-client rasterio scikit-learn einops pyyaml python-box claymodel')
  }
})