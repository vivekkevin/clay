https://we.tl/t-7EChuSLMHWp0AcQ1
# Clay Foundation Model — Web Platform

A fully functional web application for the Clay satellite foundation model, with an interactive Mapbox satellite map, real-time analysis pipeline, and rich result visualizations.

---

## Architecture

```
clay-web/
├── server/          Node.js + Express API + WebSocket server
│   └── index.js     REST endpoints, job queue, real-time logs
├── client/          React + Vite frontend
│   └── src/
│       ├── App.jsx                 Root layout
│       ├── components/
│       │   ├── Header.jsx          Top bar with map style switcher
│       │   ├── MapPanel.jsx        Mapbox GL satellite/dark/terrain map
│       │   ├── ControlPanel.jsx    Task config & job submission
│       │   ├── ResultsPanel.jsx    Metrics, charts, per-class accuracy
│       │   └── JobLog.jsx          Real-time WebSocket log stream
│       └── utils/api.js            API + WebSocket client helpers
├── start.sh         Linux/macOS one-command start
├── start.bat        Windows one-command start
└── package.json     Root scripts
```

---

## Quick Start

### Prerequisites
- **Node.js 18+** — https://nodejs.org

### Run (Linux / macOS)
```bash
cd clay-web
chmod +x start.sh
./start.sh
```

### Run (Windows)
```bat
cd clay-web
start.bat
```

### Run manually
```bash
# Terminal 1 — API server
cd server && npm install && node index.js

# Terminal 2 — Web client
cd client && npm install && npx vite
```

Then open **http://localhost:5173** in your browser.

---

## Features

### 🗺️ Interactive Mapbox Map
- **Satellite view** (default) — high-resolution imagery
- **Dark vector** and **Terrain** modes, switchable from header
- **3D globe projection** with atmosphere and stars
- **12 pre-loaded locations** worldwide (Amazon, Himalayas, Sahara, etc.)
- **Click anywhere** on the map to drop a custom pin and analyze that location
- Location markers **color-coded by satellite platform** (Sentinel, Landsat, NAIP…)
- **Popup tooltips** on hover with platform, coordinates, and description
- **Fly-to animation** when a location is selected

### ⚙️ Analysis Control Panel
- **Free-text analysis description** auto-infers the task (NLP keyword matching)
- **5 analysis tasks**: Inference · Embeddings · Land Cover · Cloud Removal · Band Viewer
- **7 satellite platforms**: Sentinel-2 L2A, Sentinel-1 RTC, Landsat C2L1/L2 SR, NAIP, LINZ, MODIS
- **4 model sizes**: tiny / small / base / large
- Task-specific options: mask ratio slider, cloud fraction, epochs, learning rate, batch size
- **GeoJSON AOI upload** for spatial filtering
- Real-time submit with WebSocket progress feedback

### 📊 Results Panel (slide-in)
- **Metrics tab** — task-specific KPIs with color-coded status
- **Charts tab** — Recharts visualizations:
  - Loss curves and accuracy history (Land Cover)
  - Per-band reconstruction loss bar chart (Inference)
  - Embedding similarity scores (Embeddings)
  - Band mean reflectance spectrum (Band Viewer)
  - Quality metrics gauge rings (Cloud Removal)
- **Log tab** — timestamped real-time pipeline log stream

### 🔌 REST API
| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Health check |
| `/api/locations` | GET | All 12 sample locations |
| `/api/platforms` | GET | Satellite platform metadata |
| `/api/jobs` | POST | Submit analysis job |
| `/api/jobs/:id` | GET | Job status + result |
| `/api/jobs` | GET | List all jobs |
| `/api/jobs/:id` | DELETE | Delete a job |
| `/api/aoi` | POST | Parse GeoJSON, return bbox + centroid |
| `/api/upload` | POST | Upload satellite image file |

WebSocket: `ws://localhost:3001?jobId=<id>` — streams log events and final result.

---

## Connecting the Real Clay Model

The server currently generates synthetic results for demonstration. To connect to the real Clay pipeline:

1. Install Clay and its dependencies in your Python environment:
   ```bash
   pip install clay-model matplotlib scikit-learn torch torchvision
   python clay_pipeline.py --setup
   ```

2. In `server/index.js`, replace the `runJob` function's body with a call to your Python scripts:
   ```js
   const py = spawn('python', ['clay_pipeline.py', '--mode', job.task, ...]);
   py.stdout.on('data', d => sendLog(jobId, d.toString().trim()));
   py.on('close', () => { /* parse result */ });
   ```

3. The `clay_app.py`, `clay_advanced.py`, `clay_pipeline.py`, and `clay_visualize.py` files you provided map directly to the 5 task runners in the web app.

---

## Mapbox Token

The app uses a public Mapbox demo token which works for development. For production:
1. Create a free account at https://mapbox.com
2. Generate an access token
3. Replace the token in `client/src/components/MapPanel.jsx`:
   ```js
   const MAPBOX_TOKEN = 'your_token_here'
   ```

---

## Sample Locations

| Location | Coordinates | Platform |
|---|---|---|
| Amazon Rainforest | -3.47°, -62.22° | Sentinel-2 |
| Sahara Desert | 23.42°, 25.66° | Sentinel-2 |
| Himalayan Glaciers | 28.22°, 85.51° | Sentinel-2 |
| Ganges Delta | 22.35°, 89.86° | Sentinel-2 |
| California Agriculture | 36.78°, -119.42° | NAIP |
| Nile Delta | 30.97°, 30.90° | Sentinel-2 |
| Arctic Sea Ice | 78.22°, 15.63° | Sentinel-1 RTC |
| Amazon Deforestation | -11.89°, -55.47° | Landsat C2L2 SR |
| Mekong Delta | 10.05°, 105.75° | Sentinel-2 |
| Great Barrier Reef | -18.29°, 147.70° | Sentinel-2 |
| Kazakh Steppe | 48.02°, 66.92° | Landsat C2L2 SR |
| Bangkok Expansion | 13.76°, 100.50° | Sentinel-2 |
