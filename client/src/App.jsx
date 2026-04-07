import { useState, useCallback } from 'react'
import MapPanel from './components/MapPanel.jsx'
import ControlPanel from './components/ControlPanel.jsx'
import ResultsPanel from './components/ResultsPanel.jsx'
import Header from './components/Header.jsx'
import JobLog from './components/JobLog.jsx'
import LULCPanel from './components/LULCPanel.jsx'
import LULCMap from './components/LULCMap.jsx'

export default function App() {
  const [selectedLocation, setSelectedLocation] = useState(null)
  const [activeJob, setActiveJob] = useState(null)
  const [jobLogs, setJobLogs] = useState([])
  const [result, setResult] = useState(null)
  const [mapStyle, setMapStyle] = useState('satellite')
  const [hoveredLocation, setHoveredLocation] = useState(null)
  const [activeView, setActiveView] = useState('map')
  const [mode, setMode] = useState('clay')
  const [lulcState, setLulcState]           = useState(null)
  const [selectedScene, setSelectedScene]   = useState(null)   // active PC STAC scene
  const [checkpointPath, setCheckpointPath] = useState('')

  const handleJobStart = useCallback((job) => {
    setActiveJob(job); setJobLogs([]); setResult(null)
    if (window.innerWidth < 900) setActiveView('results')
  }, [])
  const handleLog = useCallback((entry) => setJobLogs(prev => [...prev, entry]), [])
  const handleResult = useCallback((res) => {
    setResult(res); setActiveJob(prev => ({ ...prev, status: 'completed' }))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <Header
        mapStyle={mapStyle} onMapStyleChange={setMapStyle}
        activeView={activeView} onViewChange={setActiveView}
        activeJob={activeJob} mode={mode} onModeChange={setMode}
      />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative' }}>
        {mode === 'lulc' ? (
          <>
            <div style={{ width: 300, flexShrink: 0, background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 5 }}>
              <LULCPanel onStateChange={setLulcState} />
            </div>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <LULCMap lulcState={lulcState} mapStyle={mapStyle} />
            </div>
          </>
        ) : (
          <>
            <div style={{ flex: 1, position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <MapPanel selectedLocation={selectedLocation} onLocationSelect={setSelectedLocation} mapStyle={mapStyle} onHover={setHoveredLocation} hoveredLocation={hoveredLocation} onSceneSelect={setSelectedScene} />
              {activeJob && activeJob.status === 'running' && (
                <div style={{ position: 'absolute', bottom: 16, left: 16, right: '340px', zIndex: 10, background: 'rgba(5,7,9,0.92)', border: '1px solid var(--border)', borderRadius: 4, backdropFilter: 'blur(8px)' }}>
                  <JobLog logs={jobLogs} compact />
                </div>
              )}
            </div>
            <div style={{ width: 320, flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 5 }}>
              <ControlPanel selectedLocation={selectedLocation} onLocationSelect={setSelectedLocation} onJobStart={handleJobStart} onLog={handleLog} onResult={handleResult} activeJob={activeJob} selectedScene={selectedScene} checkpointPath={checkpointPath} />
            </div>
            <div style={{ width: result || activeJob ? 460 : 0, flexShrink: 0, background: 'var(--surface)', borderLeft: '1px solid var(--border)', overflow: 'hidden', transition: 'width 0.35s cubic-bezier(0.4,0,0.2,1)', display: 'flex', flexDirection: 'column', zIndex: 5 }}>
              {(result || activeJob) && <ResultsPanel result={result} activeJob={activeJob} logs={jobLogs} onClose={() => { setResult(null); setActiveJob(null) }} />}
            </div>
          </>
        )}
      </div>
    </div>
  )
}