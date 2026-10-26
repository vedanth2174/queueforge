import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  advanceRun,
  createRun,
  nextRunState,
  percentile,
  processingDurations,
  seeded,
  type Config,
  type RunState,
} from './simulation'

const DEFAULT_API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''
const nav = ['Overview', 'Simulation Lab', 'Benchmark Lab', 'Submit Job', 'Job Explorer', 'Settings']
const benchmarkModules = import.meta.glob('/benchmarks/results/*.json', { eager: true, import: 'default' }) as Record<string, unknown>
const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'dead', 'cancelled'] as const
type JobStatus = (typeof JOB_STATUSES)[number]
type JobCounts = Record<JobStatus, number>

function normalizeApiBase(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    activity: <path d="M3 12h4l2.5-7 5 14 2.5-7h4"/>, chart: <><path d="M4 19V5M4 19h16"/><path d="m7 15 4-4 3 2 5-6"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A8 8 0 0 0 15 6l-.3-2.6h-4L10.4 6A8 8 0 0 0 9 7L6.5 6 4.5 9.5 6.6 11a7 7 0 0 0 0 2l-2.1 1.5 2 3.4 2.4-1A8 8 0 0 0 10.4 18l.3 2.6h4L15 18a8 8 0 0 0 1.5-1l2.4 1 2-3.4-2-1.5a7 7 0 0 0 .1-1Z"/></>,
    play: <path d="m8 5 11 7-11 7Z"/>, pause: <><path d="M9 5v14M15 5v14"/></>, reset: <><path d="M4 10a8 8 0 1 1 2 7"/><path d="M4 4v6h6"/></>, step: <><path d="m6 5 9 7-9 7Z"/><path d="M18 5v14"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 11.9-2"/></>, chevron: <path d="m9 18 6-6-6-6"/>,
    server: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></>, copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>, menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

export default function App() {
  const [active, setActive] = useState('Simulation Lab'), [mobile, setMobile] = useState(false)
  const [config, setConfig] = useState<Config>({ count: 50, workers: 4, duration: 1200, workload: 'mixed', failures: 8, retries: true, seed: 42 })
  const [run, setRun] = useState(() => createRun(config)), [runState, setRunState] = useState<RunState>('ready'), [speed, setSpeed] = useState(1), [selected, setSelected] = useState<string>()
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking')
  const [apiBase, setApiBase] = useState(() => normalizeApiBase(localStorage.getItem('queueforge-api-base') ?? DEFAULT_API_BASE))
  const configRef = useRef(config), runRef = useRef(run), randomRef = useRef(seeded(config.seed))
  useEffect(() => { configRef.current = config }, [config])
  useEffect(() => { runRef.current = run }, [run])
  const checkHealth = useCallback(async () => { setHealth('checking'); try { const res = await fetch(`${apiBase}/health/live`, { signal: AbortSignal.timeout(3500) }); setHealth(res.ok ? 'online' : 'offline') } catch { setHealth('offline') } }, [apiBase])
  useEffect(() => { checkHealth(); const timer = window.setInterval(checkHealth, 30000); return () => clearInterval(timer) }, [checkHealth])
  const tick = useCallback((delta = 100) => {
    const snapshot = runRef.current
    const rolls: Record<number, number> = {}
    snapshot.workers.forEach(worker => {
      const job = snapshot.jobs.find(candidate => candidate.id === worker.jobId)
      if (job && job.remaining <= delta) rolls[worker.id] = randomRef.current() * 100
    })
    const result = advanceRun(snapshot, configRef.current, delta, rolls)
    runRef.current = result.run
    setRun(result.run)
    if (result.finished) setRunState('finished')
    return result.finished
  }, [])
  useEffect(() => { if (runState !== 'running') return; const timer = window.setInterval(() => tick(100 * speed), 100); return () => clearInterval(timer) }, [runState, speed, tick])
  const start = () => { randomRef.current = seeded(config.seed); const fresh = createRun(config); runRef.current = fresh; setRun(fresh); setSelected(undefined); setRunState('running') }
  const reset = () => { const fresh = createRun(config); runRef.current = fresh; setRun(fresh); setSelected(undefined); setRunState('ready') }
  const counts = useMemo(() => run.jobs.reduce((a, j) => ({ ...a, [j.state]: (a[j.state] || 0) + 1 }), {} as Record<string, number>), [run.jobs])
  const complete = counts.completed || 0, dead = counts.dead || 0, retries = run.jobs.reduce((a, j) => a + Math.max(0, j.attempts - 1), 0)
  const avgWait = run.jobs.reduce((a, j) => a + j.wait, 0) / run.jobs.length
  const processSamples = processingDurations(run)
  const avgProcess = processSamples.reduce((total, value) => total + value, 0) / Math.max(1, processSamples.length)
  const utilization = run.elapsed ? run.workers.reduce((a, w) => a + w.busy, 0) / (run.elapsed * run.workers.length) * 100 : 0
  const selectedJob = run.jobs.find(j => j.id === selected)
  return <div className="app-shell">
    <aside className={mobile ? 'sidebar open' : 'sidebar'}><div className="brand"><div className="brand-mark"><span/><span/><span/></div><strong>QueueForge</strong><button className="mobile-close" onClick={() => setMobile(false)}>×</button></div>
      <nav>{nav.map((item, i) => <button key={item} className={active === item ? 'nav-item active' : 'nav-item'} onClick={() => { setActive(item); setMobile(false) }}><Icon name={['grid','activity','chart','plus','search','settings'][i]}/><span>{item}</span>{item === 'Simulation Lab' && <em>LIVE</em>}</button>)}</nav>
      <div className="side-status"><div><span className={`status-dot ${health}`}/><div><strong>API {health === 'online' ? 'connected' : health}</strong><small>{health === 'online' ? 'Live backend' : 'Simulation remains available'}</small></div></div><button onClick={checkHealth}><Icon name="refresh" size={15}/></button></div>
      <div className="mode-card"><span>ENVIRONMENT</span><strong>Local playground</strong><small>Simulation data is browser-only</small></div>
    </aside>
    <main><header><button className="menu" onClick={() => setMobile(true)}><Icon name="menu"/></button><div><span className="eyebrow">QUEUEFORGE / {active.toUpperCase()}</span><h1>{active}</h1></div><div className="header-actions"><div className="connection"><span className={`status-dot ${health}`}/>{health === 'online' ? 'API online' : 'API disconnected'}</div><button className="icon-button" onClick={checkHealth}><Icon name="refresh"/></button></div></header>
    {active === 'Simulation Lab' ? <div className="page">
      <section className="intro"><div><h2>Concurrency, made visible.</h2><p>Watch deterministic jobs move through a priority queue and into parallel workers. Every value below is simulated—never mixed with production measurements.</p></div><span className="simulation-badge"><i/>SIMULATION MODE</span></section>
      <section className="control-panel">
        <Control label="Jobs"><select value={config.count} disabled={runState==='running'||runState==='paused'} onChange={e=>setConfig({...config,count:+e.target.value})}>{[10,50,100,250,500].map(v=><option key={v}>{v}</option>)}</select></Control>
        <Control label="Workers"><select value={config.workers} disabled={runState==='running'||runState==='paused'} onChange={e=>setConfig({...config,workers:+e.target.value})}>{[1,2,4,8].map(v=><option key={v}>{v}</option>)}</select></Control>
        <Control label="Base duration"><select value={config.duration} disabled={runState==='running'||runState==='paused'} onChange={e=>setConfig({...config,duration:+e.target.value})}><option value="600">600 ms</option><option value="1200">1.2 sec</option><option value="2400">2.4 sec</option></select></Control>
        <Control label="Workload"><select value={config.workload} disabled={runState==='running'||runState==='paused'} onChange={e=>setConfig({...config,workload:e.target.value})}><option value="short">Short jobs</option><option value="mixed">Mixed duration</option><option value="long">Long jobs</option></select></Control>
        <Control label="Failure rate"><select value={config.failures} disabled={runState==='running'||runState==='paused'} onChange={e=>setConfig({...config,failures:+e.target.value})}><option value="0">0%</option><option value="8">8%</option><option value="20">20%</option></select></Control>
        <Control label="Seed"><input type="number" value={config.seed} disabled={runState==='running'||runState==='paused'} onChange={e=>setConfig({...config,seed:+e.target.value})}/></Control>
        <label className="check"><input type="checkbox" checked={config.retries} disabled={runState==='running'||runState==='paused'} onChange={e=>setConfig({...config,retries:e.target.checked})}/><span>Retry failures</span></label>
      </section>
      <section className="metrics"><Metric label="Submitted" value={run.jobs.length} detail="jobs in this run"/><Metric label="Completed" value={complete} detail={`${Math.round(complete/run.jobs.length*100)}% success`} accent/><Metric label="Queue depth" value={(counts.queued||0)+(counts.retrying||0)} detail={`${counts.running||0} currently running`}/><Metric label="Retries / Dead" value={`${retries} / ${dead}`} detail={`${config.failures}% failure probability`}/><Metric label="Throughput" value={run.elapsed?`${(complete/(run.elapsed/1000)).toFixed(1)}/s`:'—'} detail="simulated completion rate"/><Metric label="Utilization" value={`${Math.min(100,utilization).toFixed(0)}%`} detail="busy time ÷ available time"/></section>
      <section className="stage"><div className="stage-head"><div><h3>Processing pipeline</h3><p>Priority queue · {config.workers} parallel workers · deterministic seed {config.seed}</p></div><div className="run-state"><span className={`status-dot ${runState==='running'?'online':''}`}/>{runState}</div></div>
        <div className="pipeline"><div className="queue-column"><Title label="WAITING QUEUE" value={(counts.queued||0)+(counts.retrying||0)}/><div className="queue-stack">{run.jobs.filter(j=>j.state==='queued'||j.state==='retrying').slice(0,7).map(job=><button key={job.id} className={`job-row ${job.state==='retrying'?'retry':''}`} onClick={()=>setSelected(job.id)}><span className="job-icon">Q</span><div><strong>{job.id}</strong><small>{job.state==='retrying'?'Retry pending':`Priority ${job.priority}`}</small></div><b>P{job.priority}</b></button>)}{!(counts.queued||counts.retrying)&&<Empty label={runState==='finished'?'Queue drained':'Ready for jobs'}/>}</div></div>
          <div className="flow-arrow"><span>CLAIM</span><Icon name="chevron"/></div><div className="workers-column"><Title label="WORKER POOL" value={`${run.workers.filter(w=>w.jobId).length}/${run.workers.length} BUSY`}/><div className="worker-grid">{run.workers.map(worker=>{const job=run.jobs.find(j=>j.id===worker.jobId);return <button key={worker.id} className={job?'worker busy':'worker'} onClick={()=>job&&setSelected(job.id)}><div className="worker-top"><span><i className={job?'pulse':''}/>WORKER {String(worker.id).padStart(2,'0')}</span><em>{job?'PROCESSING':'IDLE'}</em></div>{job?<><div className="worker-job"><strong>{job.id}</strong><span>{job.remaining>999?`${(job.remaining/1000).toFixed(1)}s`:`${Math.max(0,Math.round(job.remaining))}ms`}</span></div><div className="progress"><i style={{width:`${Math.max(2,(1-job.remaining/job.duration)*100)}%`}}/></div><small>Attempt {job.attempts} · Priority {job.priority}</small></>:<div className="idle-line"><span/>Awaiting claim</div>}</button>})}</div></div>
          <div className="flow-arrow"><span>SETTLE</span><Icon name="chevron"/></div><div className="outcome-column"><Title label="OUTCOMES" value={complete+dead}/><Outcome label="Completed" value={complete}/><Outcome label="Dead" value={dead} dead/></div></div>
        <div className="timeline"><div className="timeline-track"><i style={{width:`${Math.min(100,(complete+dead)/run.jobs.length*100)}%`}}/></div><span>{(run.elapsed/1000).toFixed(1)}s simulated</span></div>
        <div className="transport"><button className="primary" onClick={runState==='ready'||runState==='finished'?start:()=>setRunState(nextRunState(runState,'start-or-toggle'))}><Icon name={runState==='running'?'pause':'play'}/>{runState==='ready'?'Start run':runState==='finished'?'Run again':runState==='running'?'Pause':'Resume'}</button><button onClick={()=>{if(runState!=='running'){const finished=tick(100*speed);setRunState(nextRunState(runState,'step',finished))}}} disabled={runState==='running'||runState==='finished'}><Icon name="step"/>Step</button><button onClick={reset}><Icon name="reset"/>Reset</button><div className="speed"><span>PLAYBACK</span>{[.5,1,2].map(v=><button key={v} className={speed===v?'active':''} onClick={()=>setSpeed(v)}>{v}×</button>)}</div></div>
      </section>
      <section className="lower-grid"><div className="detail-card"><div className="card-head"><div><h3>Job inspector</h3><p>Select a queued or running job to inspect its lifecycle.</p></div>{selectedJob&&<button className="icon-button" onClick={()=>navigator.clipboard.writeText(selectedJob.id)}><Icon name="copy"/></button>}</div>{selectedJob?<div className="job-detail"><div className="detail-title"><div className="job-icon">Q</div><div><strong>{selectedJob.id}</strong><span className={`pill ${selectedJob.state}`}>{selectedJob.state}</span></div></div><div className="detail-grid"><Field label="Priority" value={`P${selectedJob.priority}`}/><Field label="Duration" value={`${selectedJob.duration}ms`}/><Field label="Attempts" value={`${selectedJob.attempts} / 3`}/><Field label="Worker" value={selectedJob.worker?`Worker ${selectedJob.worker}`:'Unassigned'}/></div><div className="history">{selectedJob.history.slice().reverse().map((h,i)=><div key={i}><i/><span>{h}</span></div>)}</div></div>:<Empty label="No job selected" sub="Choose a job from the queue or a worker lane."/ >}</div>
        <div className="detail-card"><div className="card-head"><div><h3>Run measurements</h3><p>Computed only from this simulation engine.</p></div><span className="mini-tag">SIMULATED</span></div><div className="measure-list"><Measure name="Average wait" value={`${avgWait.toFixed(0)} ms`}/><Measure name="p95 wait" value={`${percentile(run.jobs.map(j=>j.wait),95).toFixed(0)} ms`}/><Measure name="Average processing" value={processSamples.length?`${avgProcess.toFixed(0)} ms`:'—'}/><Measure name="p95 processing" value={processSamples.length?`${percentile(processSamples,95).toFixed(0)} ms`:'—'}/><Measure name="Total completion time" value={`${(run.elapsed/1000).toFixed(1)} sec`}/></div><p className="method">Processing statistics use the same population: terminal jobs only, including all retry attempt time. Percentiles use nearest rank.</p></div></section>
    </div>:active === 'Overview' ? <Overview apiBase={apiBase}/> : active === 'Submit Job' ? <SubmitJob apiBase={apiBase}/> : active === 'Job Explorer' ? <JobExplorer apiBase={apiBase}/> : active === 'Benchmark Lab' ? <BenchmarkLab/> : <Settings apiBase={apiBase} onSave={value => { const normalized = normalizeApiBase(value); localStorage.setItem('queueforge-api-base', normalized); setApiBase(normalized) }} health={health}/>}</main>
  </div>
}
function Control({label,children}:{label:string;children:React.ReactNode}){return <div className="field"><label>{label}</label>{children}</div>}
function Metric({label,value,detail,accent}:{label:string;value:string|number;detail:string;accent?:boolean}){return <div className={`metric ${accent?'accent':''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>}
function Title({label,value}:{label:string;value:string|number}){return <div className="column-title"><span>{label}</span><strong>{value}</strong></div>}
function Outcome({label,value,dead}:{label:string;value:number;dead?:boolean}){return <div className={`outcome ${dead?'dead':''}`}><div><span>{dead?'×':'✓'}</span><p><strong>{value}</strong><small>{label}</small></p></div></div>}
function Empty({label,sub}:{label:string;sub?:string}){return <div className="empty"><span>◇</span><strong>{label}</strong>{sub&&<small>{sub}</small>}</div>}
function Field({label,value}:{label:string;value:string}){return <div><span>{label}</span><strong>{value}</strong></div>}
function Measure({name,value}:{name:string;value:string}){return <div><span>{name}</span><strong>{value}</strong></div>}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function findJobCounts(value: unknown): JobCounts | undefined {
  if (!isRecord(value)) return undefined
  const populatedStatuses = JOB_STATUSES.filter((status) => {
    const count = value[status]
    return typeof count === 'number' || (typeof count === 'string' && count.trim() !== '')
  })
  if (populatedStatuses.length) {
    const counts = {} as JobCounts
    for (const status of JOB_STATUSES) {
      const parsed = Number(value[status])
      if (!Number.isFinite(parsed) || parsed < 0) return undefined
      counts[status] = parsed
    }
    return counts
  }
  for (const child of Object.values(value)) {
    const counts = findJobCounts(child)
    if (counts) return counts
  }
  return undefined
}
function Overview({apiBase}:{apiBase:string}) {
  const [data,setData]=useState<{live?:boolean;ready?:boolean;counts?:JobCounts;raw?:unknown;error?:string;loading:boolean}>({loading:true})
  const load=useCallback(async()=>{setData(previous=>({...previous,loading:true,error:undefined}));try{const [live,ready,metrics]=await Promise.all([fetch(`${apiBase}/health/live`,{signal:AbortSignal.timeout(5000)}),fetch(`${apiBase}/health/ready`,{signal:AbortSignal.timeout(5000)}),fetch(`${apiBase}/metrics`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(5000)})]);if(!metrics.ok)throw new Error(`Metrics returned HTTP ${metrics.status}`);const raw:unknown=await metrics.json();const counts=findJobCounts(raw);if(!counts)throw new Error('Metrics JSON did not contain all six QueueForge job counts');setData({live:live.ok,ready:ready.ok,counts,raw,loading:false})}catch(error){setData({loading:false,error:error instanceof Error?error.message:'Unable to connect'})}},[apiBase])
  useEffect(()=>{load();const timer=window.setInterval(load,15000);return()=>clearInterval(timer)},[load])
  return <DataPage title="Operations overview" description="Live health and measurements reported by the QueueForge API." action={<button className="page-button" onClick={load} disabled={data.loading}><Icon name="refresh"/>Refresh</button>}>
    <div className="metrics overview-health"><Metric label="API liveness" value={data.loading?'…':data.live?'Healthy':'Unavailable'} detail="/health/live"/><Metric label="Database readiness" value={data.loading?'…':data.ready?'Ready':'Unavailable'} detail="/health/ready"/></div>
    {data.error?<Notice title="Metrics unavailable" text={data.error}/>:<div className="metrics job-counts">{JOB_STATUSES.map(status=><Metric key={status} label={status} value={data.loading?'…':data.counts?.[status]??'—'} detail="jobs reported by API" accent={status==='completed'}/>)}</div>}
    {data.raw!==undefined&&<div className="data-card"><div className="card-head"><div><h3>Metrics response</h3><p>Actual JSON returned by GET /metrics.</p></div><span className="mini-tag">LIVE</span></div><pre className="json-view compact">{JSON.stringify(data.raw,null,2)}</pre></div>}
  </DataPage>
}

function getErrorMessage(body: unknown, status: number) {
  if (isRecord(body)) {
    if (typeof body.message === 'string') return body.message
    if (typeof body.error === 'string') return body.error
  }
  return `Request failed with HTTP ${status}`
}

function getJobId(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  if (typeof body.id === 'string') return body.id
  if (typeof body.jobId === 'string') return body.jobId
  return isRecord(body.job) && typeof body.job.id === 'string' ? body.job.id : undefined
}

function SubmitJob({apiBase}:{apiBase:string}) {
  const [type,setType]=useState('')
  const [payload,setPayload]=useState('{\n  "task": "example"\n}')
  const [priority,setPriority]=useState('0'),[maxAttempts,setMaxAttempts]=useState('3')
  const [runAt,setRunAt]=useState(''),[idempotencyKey,setIdempotencyKey]=useState('')
  const [response,setResponse]=useState<unknown>(),[jobId,setJobId]=useState<string>()
  const [error,setError]=useState(''),[loading,setLoading]=useState(false)
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();setError('');setResponse(undefined);setJobId(undefined)
    const normalizedType=type.trim()
    if(!normalizedType){setError('Job type is required.');return}
    let parsedPayload:unknown
    try{parsedPayload=JSON.parse(payload)}catch{setError('Payload must be valid JSON.');return}
    if(!isRecord(parsedPayload)){setError('Payload must be a JSON object.');return}
    const parsedPriority=Number(priority),parsedMaxAttempts=Number(maxAttempts)
    if(!Number.isSafeInteger(parsedPriority)||parsedPriority<0||parsedPriority>10){setError('Priority must be an integer from 0 to 10.');return}
    if(!Number.isSafeInteger(parsedMaxAttempts)||parsedMaxAttempts<1||parsedMaxAttempts>10){setError('Maximum attempts must be an integer from 1 to 10.');return}
    let normalizedRunAt:string|undefined
    if(runAt){const timestamp=new Date(runAt);if(Number.isNaN(timestamp.getTime())){setError('runAt must be a valid date and time.');return}normalizedRunAt=timestamp.toISOString()}
    const requestBody:Record<string,unknown>={type:normalizedType,payload:parsedPayload,priority:parsedPriority,maxAttempts:parsedMaxAttempts}
    if(normalizedRunAt)requestBody.runAt=normalizedRunAt
    const headers:Record<string,string>={'Content-Type':'application/json','Accept':'application/json'}
    if(idempotencyKey.trim())headers['Idempotency-Key']=idempotencyKey.trim()
    setLoading(true)
    try{const result=await fetch(`${apiBase}/api/v1/jobs`,{method:'POST',headers,body:JSON.stringify(requestBody),signal:AbortSignal.timeout(10000)});const body:unknown=await result.json().catch(()=>null);if(!result.ok)throw new Error(getErrorMessage(body,result.status));setResponse(body);setJobId(getJobId(body))}catch(reason){setError(reason instanceof Error?reason.message:'Unable to submit job')}finally{setLoading(false)}
  }
  return <DataPage title="Submit a job" description="Create a real PostgreSQL-backed QueueForge job. The request is sent directly to POST /api/v1/jobs.">
    <form className="submission-card data-card" onSubmit={submit}>
      <div className="card-head"><div><h3>Job request</h3><p>Payload is validated locally before it is sent.</p></div><span className="mini-tag">LIVE API</span></div>
      <div className="submission-fields"><Control label="Job type"><input value={type} onChange={event=>setType(event.target.value)} required autoComplete="off" placeholder="email.send"/></Control><Control label="JSON payload"><textarea value={payload} onChange={event=>setPayload(event.target.value)} spellCheck={false} aria-label="JSON payload"/></Control><div className="form-grid"><Control label="Priority"><input type="number" min="0" max="10" step="1" value={priority} onChange={event=>setPriority(event.target.value)}/></Control><Control label="Maximum attempts"><input type="number" min="1" max="10" step="1" value={maxAttempts} onChange={event=>setMaxAttempts(event.target.value)}/></Control><Control label="Run at (optional)"><input type="datetime-local" value={runAt} onChange={event=>setRunAt(event.target.value)}/></Control><Control label="Idempotency key (optional)"><input value={idempotencyKey} onChange={event=>setIdempotencyKey(event.target.value)} autoComplete="off"/></Control></div><p className="form-help">Priority accepts 0–10 and maximum attempts accepts 1–10. The idempotency key is sent in the <code>Idempotency-Key</code> header. runAt is sent as an ISO 8601 timestamp.</p><button className="page-button primary" disabled={loading}>{loading?'Submitting…':'Submit job'}</button></div>
    </form>
    {error&&<Notice title="Job submission failed" text={error}/>}
    {response!==undefined&&<div className="data-card response-card"><div className="card-head"><div><h3>API response</h3><p>{jobId?`Created job ${jobId}`:'The API succeeded but did not expose a recognizable job ID.'}</p></div>{jobId&&<strong className="response-id">{jobId}</strong>}</div><pre className="json-view">{JSON.stringify(response,null,2)}</pre></div>}
  </DataPage>
}
function JobExplorer({apiBase}:{apiBase:string}) {
  const [id,setId]=useState(''),[job,setJob]=useState<unknown>(),[error,setError]=useState(''),[loading,setLoading]=useState(false)
  const find=async(event:React.FormEvent)=>{event.preventDefault();if(!id.trim())return;setLoading(true);setError('');setJob(undefined);try{const response=await fetch(`${apiBase}/api/v1/jobs/${encodeURIComponent(id.trim())}`,{signal:AbortSignal.timeout(8000)});const body=await response.json().catch(()=>null);if(!response.ok)throw new Error((body as {message?:string})?.message??`Request failed with HTTP ${response.status}`);setJob(body)}catch(reason){setError(reason instanceof Error?reason.message:'Unable to retrieve job')}finally{setLoading(false)}}
  return <DataPage title="Job explorer" description="Retrieve a real PostgreSQL-backed job by UUID. No browser-generated records are shown."><form className="lookup" onSubmit={find}><input value={id} onChange={event=>setId(event.target.value)} placeholder="Enter job UUID" aria-label="Job UUID"/><button className="page-button primary" disabled={loading||!id.trim()}><Icon name="search"/>{loading?'Looking up…':'Find job'}</button></form>{error&&<Notice title="Job lookup failed" text={error}/>} {job!==undefined&&<div className="data-card"><div className="card-head"><div><h3>API response</h3><p>Current job data from GET /api/v1/jobs/:id.</p></div><button className="icon-button" onClick={()=>navigator.clipboard.writeText(JSON.stringify(job,null,2))}><Icon name="copy"/></button></div><pre className="json-view">{JSON.stringify(job,null,2)}</pre></div>}</DataPage>
}

type BenchmarkRecord = {
  source:string
  label:string
  recordedAt?:string
  throughput?:number
  jobs?:number
  workers?:number
  enqueueToClaim:BenchmarkPercentiles
  processing:BenchmarkPercentiles
  processingStartToClaim:BenchmarkPercentiles
  raw:unknown
}

type BenchmarkPercentiles = {
  p50?:number
  p95?:number
  p99?:number
}

function numericValue(value:unknown) {
  if(typeof value==='number'&&Number.isFinite(value))return value
  if(typeof value==='string'&&value.trim()&&Number.isFinite(Number(value)))return Number(value)
}

function parsePercentiles(value:unknown):BenchmarkPercentiles {
  if(!isRecord(value))return {}
  return {p50:numericValue(value.p50),p95:numericValue(value.p95),p99:numericValue(value.p99)}
}

function parseBenchmark(source:string,raw:unknown):BenchmarkRecord|undefined {
  if(!isRecord(raw))return undefined
  const metrics=isRecord(raw.metrics)?raw.metrics:raw
  const throughput=numericValue(metrics.throughputJobsPerSecond)
  const jobs=numericValue(metrics.jobs)
  const workers=numericValue(metrics.workers)
  const enqueueToClaim=parsePercentiles(metrics.queueWaitFromEnqueueMs)
  const processing=parsePercentiles(metrics.processingMs)
  const processingStartToClaim=parsePercentiles(metrics.queueWaitFromProcessingStartMs)
  const values=[throughput,jobs,workers,...Object.values(enqueueToClaim),...Object.values(processing),...Object.values(processingStartToClaim)]
  if(values.every(value=>value===undefined))return undefined
  const label=typeof raw.name==='string'?raw.name:typeof raw.scenario==='string'?raw.scenario:source.replace(/\.json$/,'')
  const recordedAt=typeof raw.recordedAt==='string'?raw.recordedAt:typeof raw.timestamp==='string'?raw.timestamp:undefined
  return {source,label,recordedAt,throughput,jobs,workers,enqueueToClaim,processing,processingStartToClaim,raw}
}

function formatMeasurement(value:number|undefined,unit='') {
  return value===undefined?'Not recorded':`${value.toLocaleString()}${unit}`
}

function BenchmarkChart({records}:{records:BenchmarkRecord[]}) {
  const definitions=[
    {key:'throughput',label:'Throughput',unit:' jobs/s',value:(record:BenchmarkRecord)=>record.throughput},
    {key:'enqueue-p95',label:'Enqueue-to-claim p95',unit:' ms',value:(record:BenchmarkRecord)=>record.enqueueToClaim.p95},
    {key:'processing-p95',label:'Processing p95',unit:' ms',value:(record:BenchmarkRecord)=>record.processing.p95},
    {key:'processing-start-p95',label:'Processing-start-to-claim p95',unit:' ms',value:(record:BenchmarkRecord)=>record.processingStartToClaim.p95},
  ]
  return <div className="data-card benchmark-chart"><div className="card-head"><div><h3>Historical measurement comparison</h3><p>Recorded p95 values are charted separately by measurement; missing values are omitted.</p></div><span className="mini-tag">MEASURED · NOT SIMULATED</span></div><div className="chart-groups">{definitions.map(definition=>{const available=records.flatMap(record=>{const value=definition.value(record);return value===undefined?[]:[{record,value}]});if(!available.length)return null;const maximum=Math.max(...available.map(item=>item.value));return <div className="chart-group" key={definition.key}><strong>{definition.label}</strong>{available.map(({record,value})=><div className="chart-row" key={`${definition.key}-${record.source}`}><span title={record.label}>{record.label}</span><div><i style={{width:`${maximum?value/maximum*100:0}%`}}/></div><code>{value.toLocaleString()}{definition.unit}</code></div>)}</div>})}</div></div>
}

function BenchmarkLab() {
  const entries=Object.entries(benchmarkModules).map(([path,value])=>({source:path.replace(/^.*\//,''),value}))
  const records=entries.flatMap(entry=>{const record=parseBenchmark(entry.source,entry.value);return record?[record]:[]})
  const invalid=entries.filter(entry=>!parseBenchmark(entry.source,entry.value)).map(entry=>entry.source)
  return <DataPage title="Historical benchmarks" description="Measured benchmark artifacts compiled into this standalone frontend from benchmarks/results/. Live execution remains disabled."><div className="safety-banner"><Icon name="server"/><div><strong>Historical measurements only</strong><span>These results come from recorded artifacts, not the Simulation Lab. No benchmark process or public execution endpoint is available from this frontend.</span></div></div>{records.length?<><div className="data-card benchmark-summary"><div className="card-head"><div><h3>Recorded run comparison</h3><p>Every cell is read from a bundled artifact; unavailable measurements are marked as not recorded.</p></div><span className="mini-tag">MEASURED · NOT SIMULATED</span></div><div className="table-scroll"><table><thead><tr><th>Record</th><th>Recorded at</th><th>Workers</th><th>Jobs</th><th>Throughput</th><th>Enqueue-to-claim p50</th><th>Enqueue-to-claim p95</th><th>Enqueue-to-claim p99</th><th>Processing p50</th><th>Processing p95</th><th>Processing p99</th><th>Processing-start-to-claim p50</th><th>Processing-start-to-claim p95</th><th>Processing-start-to-claim p99</th></tr></thead><tbody>{records.map(record=><tr key={record.source}><td><strong>{record.label}</strong><small>{record.source}</small></td><td>{record.recordedAt??'Not recorded'}</td><td>{formatMeasurement(record.workers)}</td><td>{formatMeasurement(record.jobs)}</td><td>{formatMeasurement(record.throughput,' jobs/s')}</td><td>{formatMeasurement(record.enqueueToClaim.p50,' ms')}</td><td>{formatMeasurement(record.enqueueToClaim.p95,' ms')}</td><td>{formatMeasurement(record.enqueueToClaim.p99,' ms')}</td><td>{formatMeasurement(record.processing.p50,' ms')}</td><td>{formatMeasurement(record.processing.p95,' ms')}</td><td>{formatMeasurement(record.processing.p99,' ms')}</td><td>{formatMeasurement(record.processingStartToClaim.p50,' ms')}</td><td>{formatMeasurement(record.processingStartToClaim.p95,' ms')}</td><td>{formatMeasurement(record.processingStartToClaim.p99,' ms')}</td></tr>)}</tbody></table></div></div><BenchmarkChart records={records}/><div className="metric-definitions"><div><strong>Throughput</strong><span>Jobs completed per second during the recorded benchmark interval.</span></div><div><strong>Enqueue-to-claim wait</strong><span>Time from enqueue until a worker claims the job.</span></div><div><strong>Processing time</strong><span>Time spent processing the job as reported by the benchmark runner.</span></div><div><strong>Processing-start-to-claim wait</strong><span>Queue wait measured from the benchmark processing-start reference until claim.</span></div></div><details className="artifact-details"><summary>View source artifacts</summary><div className="benchmark-grid">{records.map(record=><div className="data-card" key={record.source}><div className="card-head"><div><h3>{record.source}</h3><p>Bundled historical benchmark JSON</p></div></div><pre className="json-view compact">{JSON.stringify(record.raw,null,2)}</pre></div>)}</div></details></>:<Notice title="No recorded benchmark measurements" text="No genuine benchmark JSON artifacts are available under benchmarks/results/. Measurements are never generated or fabricated by this frontend."/>}{invalid.length>0&&<Notice title="Skipped incompatible artifacts" text={`No supported QueueForge benchmark measurements were found in: ${invalid.join(', ')}`}/>}</DataPage>
}
function Settings({apiBase,onSave,health}:{apiBase:string;onSave:(value:string)=>void;health:string}) {
  const [value,setValue]=useState(apiBase)
  return <DataPage title="Connection settings" description="Configure the public API origin used by this browser. Credentials and server environment variables are never displayed."><div className="settings-card data-card"><Control label="API base URL"><input value={value} onChange={event=>setValue(event.target.value)} placeholder="Same origin"/></Control><p>Use an empty value for same-origin requests through the local proxy. Changes are stored only in this browser.</p><button className="page-button primary" onClick={()=>onSave(value)}>Save connection</button><div className="connection-row"><span className={`status-dot ${health}`}/><div><strong>{health}</strong><small>{apiBase||'Same origin / local proxy'}</small></div></div></div></DataPage>
}
function DataPage({title,description,action,children}:{title:string;description:string;action?:React.ReactNode;children:React.ReactNode}){return <div className="page"><section className="intro"><div><h2>{title}</h2><p>{description}</p></div>{action}</section>{children}</div>}
function Notice({title,text}:{title:string;text:string}){return <div className="notice"><span>◇</span><div><strong>{title}</strong><p>{text}</p></div></div>}
