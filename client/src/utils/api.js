const BASE = '/api';

export async function getLocations() {
  const r = await fetch(`${BASE}/locations`);
  return r.json();
}

export async function getLocation(id) {
  const r = await fetch(`${BASE}/locations/${id}`);
  return r.json();
}

export async function getPlatforms() {
  const r = await fetch(`${BASE}/platforms`);
  return r.json();
}

export async function submitJob(task, params) {
  const r = await fetch(`${BASE}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, params }),
  });
  return r.json();
}

export async function getJob(id) {
  const r = await fetch(`${BASE}/jobs/${id}`);
  return r.json();
}

export async function getJobs() {
  const r = await fetch(`${BASE}/jobs`);
  return r.json();
}

export async function deleteJob(id) {
  const r = await fetch(`${BASE}/jobs/${id}`, { method: 'DELETE' });
  return r.json();
}

export async function parseAOI(geojson) {
  const r = await fetch(`${BASE}/aoi`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ geojson }),
  });
  return r.json();
}

export function createJobSocket(jobId, onMessage) {
  const wsUrl = `ws://${window.location.hostname}:3001?jobId=${jobId}`;
  const ws = new WebSocket(wsUrl);
  ws.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch {}
  };
  ws.onerror = () => {};
  return ws;
}

export const TASK_INFO = {
  inference: {
    label: 'Inference',
    icon: '◈',
    color: '#00aaff',
    description: 'Mask patches & reconstruct via Clay MAE encoder-decoder',
  },
  embeddings: {
    label: 'Embeddings',
    icon: '◉',
    color: '#9966ff',
    description: 'Extract CLS & patch embeddings, PCA, similarity search',
  },
  landcover: {
    label: 'Land Cover',
    icon: '◧',
    color: '#00ff88',
    description: 'Fine-tune classification head on frozen Clay encoder',
  },
  cloudremoval: {
    label: 'Cloud Removal',
    icon: '◌',
    color: '#ffaa00',
    description: 'Reconstruct cloudy pixels from visible patches',
  },
  bands: {
    label: 'Band Viewer',
    icon: '◫',
    color: '#8bb0cc',
    description: 'Visualize all spectral bands with wavelength metadata',
  },
};

export const PLATFORM_COLORS = {
  'sentinel-2-l2a': '#00ff88',
  'sentinel-1-rtc': '#ffaa00',
  'landsat-c2l1': '#00aaff',
  'landsat-c2l2-sr': '#9966ff',
  'naip': '#ff4455',
  'linz': '#00ccff',
  'modis': '#ffcc44',
};
