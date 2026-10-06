import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Activity, AudioLines, Check, ChevronRight, CircleAlert, Clock3, FilePlus2, History, ImagePlus, LogOut, Radio, Search, Settings2, ShieldCheck, SlidersHorizontal, Terminal, Upload, X } from 'lucide-react';

type User = { id: string; email: string; role: 'Admin' };
type PublicPost = { jurisdiction: string; call: string; location: string; extraInfo: string; timeReceived: string; includeAudio: boolean; sensitivity: 'low'|'moderate'|'high'; suggestedImage: string|null };
type Summary = { id: string; talkgroup_id: string; talkgroup_label: string; event_type: string; status: string; priority: 'high'|'medium'|'low'; received_at: string; public_data: PublicPost; image_id: string|null; image_name: string|null; facebook_post_id?: string; publish_error?: string };
type Detail = Summary & { transcript: string|null; internal_data: Record<string, unknown>|null; original_path?: string|null; source_metadata?: Record<string, unknown>; audioUrl: string|null; originalUrl: string|null; publicAudioUrl: string|null; renderedPost: string; approvals: { created_at: string; email: string }[]; audit: { action: string; details: Record<string, unknown>; created_at: string; email: string|null }[] };
type Talkgroup = { id: string; label: string; enabled: boolean };
type ImageRecord = { id: string; name: string; location: string; enabled: boolean };
type RadioKey = { id: string; name: string; system_id: string; talkgroup_ids: string[]; enabled: boolean; created_at: string; last_used_at: string|null };
type ReceiverRequest = { id: number; received_at: string; method: string; path: string; status_code: number; system_id: string|null; talkgroup_id: string|null; summary: string; details: Record<string, unknown> };
type Tab = 'calls'|'queue'|'history'|'settings'|'audit'|'receiver';

const emptyPost = (): PublicPost => ({ jurisdiction: '', call: '', location: '', extraInfo: '', timeReceived: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()) + ' hrs', includeAudio: true, sensitivity: 'low', suggestedImage: null });
const statusLabels: Record<string,string> = { processing: 'Processing', draft: 'Needs review', approved: 'Approved', rejected: 'Rejected', publish_queued: 'Publishing', published: 'Published', publish_failed: 'Publish failed', publish_unknown: 'Verify Facebook' };

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('signal-token') ?? '');
  const [user, setUser] = useState<User|null>(null);
  const [loginError, setLoginError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tab, setTab] = useState<Tab>('calls');
  const [incidents, setIncidents] = useState<Summary[]>([]);
  const [selectedId, setSelectedId] = useState(new URLSearchParams(location.search).get('incident') ?? '');
  const [detail, setDetail] = useState<Detail|null>(null);
  const [talkgroups, setTalkgroups] = useState<Talkgroup[]>([]);
  const [images, setImages] = useState<ImageRecord[]>([]);
  const [radioKeys, setRadioKeys] = useState<RadioKey[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [talkgroupFilter, setTalkgroupFilter] = useState('');
  const [search, setSearch] = useState('');
  const [postDraft, setPostDraft] = useState<PublicPost>(emptyPost());
  const [postPreview, setPostPreview] = useState('');
  const [imageId, setImageId] = useState('');
  const [imagePreview, setImagePreview] = useState('');
  const [playableObjectUrl, setPlayableObjectUrl] = useState('');
  const [originalObjectUrl, setOriginalObjectUrl] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [serviceStatus, setServiceStatus] = useState({ apiOnline: false, workerOnline: false });
  const [modal, setModal] = useState(false);
  const [newPost, setNewPost] = useState<PublicPost>(emptyPost());
  const [newRadioKey, setNewRadioKey] = useState({ name: '', systemId: '' });
  const [createdRadioKey, setCreatedRadioKey] = useState('');
  const [reconcilePostId, setReconcilePostId] = useState('');
  const modalRef = useRef<HTMLElement|null>(null);
  const manualButtonRef = useRef<HTMLButtonElement|null>(null);

  const canReview = user?.role === 'Admin' || user?.role === 'Reviewer';
  const isAdmin = user?.role === 'Admin';
  const counts = useMemo(() => incidents.reduce<Record<string,number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}), [incidents]);
  const selectedStatus = incidents.find(item => item.id === selectedId)?.status;

  async function loadQueue() {
    if (!token) return;
    const params = new URLSearchParams();
    if (statusFilter) params.set('status', statusFilter);
    if (talkgroupFilter) params.set('talkgroup', talkgroupFilter);
    if (search.trim()) params.set('q', search.trim());
    if (tab === 'calls') params.set('callsOnly', 'true');
    const result = await request<{ incidents: Summary[] }>(`/incidents?${params}`, token);
    setIncidents(result.incidents);
  }

  async function loadDetails(id: string) {
    if (!token || !id) { setDetail(null); return; }
    const data = await request<Detail>(`/incidents/${id}`, token);
    const publicData = { ...emptyPost(), ...(data.public_data ?? {}) };
    setDetail({ ...data, public_data: publicData });
    setPostDraft(publicData);
    setImageId(data.image_id ?? '');
  }

  async function loadSupportData() {
    if (!token) return;
    const [tg, bank, keyResult] = await Promise.all([
      request<{talkgroups:Talkgroup[]}>('/talkgroups', token),
      request<{images:ImageRecord[]}>('/images', token),
      isAdmin ? request<{keys:RadioKey[]}>('/radio-keys', token) : Promise.resolve({ keys: [] as RadioKey[] })
    ]);
    setTalkgroups(tg.talkgroups);
    setImages(bank.images);
    setRadioKeys(keyResult.keys);
  }

  useEffect(() => {
    if (!token) { setUser(null); return; }
    let active = true;
    request<User>('/auth/me', token).then(value => { if (active) setUser(value); }).catch(() => { localStorage.removeItem('signal-token'); setToken(''); });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    let active = true;
    const check = () => fetch('/api/health').then(response => response.ok ? response.json() as Promise<{ workerOnline: boolean }> : Promise.reject()).then(result => { if (active) setServiceStatus({ apiOnline: true, workerOnline: result.workerOnline }); }).catch(() => { if (active) setServiceStatus({ apiOnline: false, workerOnline: false }); });
    void check();
    const timer = window.setInterval(check, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadSupportData().catch(error => setNotice(error.message));
  }, [user, isAdmin]);

  useEffect(() => {
    if (!user) return;
    void loadQueue().catch(error => setNotice(error.message));
    const timer = window.setInterval(() => { void loadQueue().catch(() => undefined); }, 8000);
    return () => window.clearInterval(timer);
  }, [user, statusFilter, talkgroupFilter, search, tab]);

  useEffect(() => { if (selectedId) void loadDetails(selectedId).catch(error => setNotice(error.message)); else setDetail(null); }, [selectedId, token]);

  useEffect(() => {
    if (selectedId && selectedStatus && detail && selectedStatus !== detail.status) void loadDetails(selectedId).catch(error => setNotice(error.message));
  }, [selectedId, selectedStatus, detail?.status, token]);

  useEffect(() => {
    if (!detail) { setPostPreview(''); return; }
    if (!canReview) { setPostPreview(detail.renderedPost); return; }
    if (!postDraft.jurisdiction.trim() || !postDraft.call.trim()) { setPostPreview('Complete the jurisdiction and call fields to preview.'); return; }
    const timer = window.setTimeout(() => {
      request<{ renderedPost: string }>('/post-preview', token, { method: 'POST', body: JSON.stringify({ incidentId: detail.id, publicData: postDraft }) })
        .then(result => setPostPreview(result.renderedPost)).catch(() => setPostPreview('Preview unavailable.'));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [detail?.id, detail?.renderedPost, postDraft, token, canReview]);

  useEffect(() => {
    if (!modal) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = modalRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') ?? []);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setModal(false); return; }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (!elements.length) return;
      if (event.shiftKey && document.activeElement === elements[0]) { event.preventDefault(); elements.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0]?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); previousFocus?.focus(); };
  }, [modal]);

  useEffect(() => {
    let objectUrl = '';
    if (token && imageId) {
      const selected = images.find(image => image.id === imageId);
      if (selected) fetch(`/api/images/${imageId}/file`, { headers: { Authorization: `Bearer ${token}` } }).then(response => response.ok ? response.blob() : null).then(blob => { if (blob) { objectUrl = URL.createObjectURL(blob); setImagePreview(objectUrl); } }).catch(() => undefined);
    } else setImagePreview('');
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [token, imageId, images]);

  useEffect(() => {
    const controller = new AbortController();
    let playableUrl = '';
    let originalUrl = '';
    const loadAudio = async (path: string|null, setUrl: (value: string) => void, assign: (value: string) => void) => {
      if (!path) { setUrl(''); return; }
      try {
        const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!response.ok) throw new Error('Audio unavailable');
        const objectUrl = URL.createObjectURL(await response.blob());
        if (controller.signal.aborted) { URL.revokeObjectURL(objectUrl); return; }
        assign(objectUrl);
        setUrl(objectUrl);
      } catch { if (!controller.signal.aborted) setUrl(''); }
    };
    void loadAudio(detail?.audioUrl ?? null, setPlayableObjectUrl, value => { playableUrl = value; });
    void loadAudio(detail?.originalUrl ?? null, setOriginalObjectUrl, value => { originalUrl = value; });
    return () => { controller.abort(); if (playableUrl) URL.revokeObjectURL(playableUrl); if (originalUrl) URL.revokeObjectURL(originalUrl); };
  }, [detail?.audioUrl, detail?.originalUrl, token]);

  function selectIncident(id: string) {
    setSelectedId(id);
    const next = new URL(location.href);
    if (id) next.searchParams.set('incident', id); else next.searchParams.delete('incident');
    history.replaceState(null, '', next);
  }

  async function login(event: FormEvent) {
    event.preventDefault(); setLoginError(''); setBusy(true);
    try {
      const result = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }).then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data as { token: string; user: User }; });
      localStorage.setItem('signal-token', result.token); setToken(result.token); setUser(result.user);
    } catch (error) { setLoginError(error instanceof Error ? error.message : 'Unable to sign in'); }
    finally { setBusy(false); }
  }

  async function perform(path: string, method: string, body?: unknown, message?: string) {
    if (!detail) return;
    setBusy(true); setNotice('');
    try {
      await request(path, token, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await Promise.all([loadQueue(), loadDetails(detail.id)]);
      setNotice(message ?? 'Saved');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Action failed'); }
    finally { setBusy(false); }
  }

  async function savePost() {
    if (!detail) return;
    await perform(`/incidents/${detail.id}`, 'PATCH', { publicData: postDraft, imageId: imageId || null }, 'Draft saved. Approval was cleared until the revised post is approved.');
  }

  async function changePriority(priority: Summary['priority']) {
    if (!detail || priority === detail.priority) return;
    setBusy(true); setNotice('');
    try {
      await request(`/incidents/${detail.id}/priority`, token, { method: 'PATCH', body: JSON.stringify({ priority }) });
      await Promise.all([loadQueue(), loadDetails(detail.id)]);
      setNotice(`Internal priority changed to ${priority}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Priority could not be changed'); }
    finally { setBusy(false); }
  }

  async function approvePost() {
    if (!detail) return;
    setBusy(true); setNotice('');
    try {
      await request(`/incidents/${detail.id}`, token, { method: 'PATCH', body: JSON.stringify({ publicData: postDraft, imageId: imageId || null }) });
      await request(`/incidents/${detail.id}/approve`, token, { method: 'POST', body: JSON.stringify({}) });
      await Promise.all([loadQueue(), loadDetails(detail.id)]);
      setNotice('Draft saved and approved. Publishing remains a separate action.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save and approve draft'); }
    finally { setBusy(false); }
  }

  async function resolvePublication(postId?: string) {
    if (!detail) return;
    if (!postId && !window.confirm('Confirm that you checked the Facebook Page and this incident was not published? This unlocks a retry.')) return;
    setBusy(true);
    try {
      await request(`/incidents/${detail.id}/resolve-publication`, token, { method: 'POST', body: JSON.stringify(postId ? { facebookPostId: postId } : { confirmedNotPublished: true }) });
      setReconcilePostId(''); await Promise.all([loadQueue(),loadDetails(detail.id)]); setNotice(postId ? 'Facebook post ID recorded' : 'No publication recorded; a human retry is now available');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Reconciliation failed'); }
    finally { setBusy(false); }
  }

  async function createManualPost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const talkgroupId = String(data.get('talkgroupId') ?? '');
    setBusy(true);
    try {
      const result = await request<{id:string}>('/incidents', token, { method: 'POST', body: JSON.stringify({ talkgroupId, publicData: newPost }) });
      setModal(false); setNewPost(emptyPost()); await loadQueue(); selectIncident(result.id); setNotice('Manual draft created');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not create draft'); }
    finally { setBusy(false); }
  }

  async function uploadAudio(event: ChangeEvent<HTMLInputElement>) {
    if (!detail || !event.target.files?.[0]) return;
    const form = new FormData(); form.append('audio', event.target.files[0]); setBusy(true);
    try { await request(`/incidents/${detail.id}/audio`, token, { method: 'POST', body: form }); setNotice('Audio received and queued for processing'); await loadDetails(detail.id); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Upload failed'); }
    finally { setBusy(false); event.target.value = ''; }
  }

  async function createRadioKey(event: FormEvent) {
    event.preventDefault();
    try {
      const result = await request<{ apiKey: string }>('/radio-keys', token, { method: 'POST', body: JSON.stringify(newRadioKey) });
      setCreatedRadioKey(result.apiKey);
      setNewRadioKey({ name: '', systemId: '' });
      await loadSupportData();
      setNotice('Receiver key created. Copy it now; it will not be shown again.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Receiver key not created'); }
  }

  async function revokeRadioKey(key: RadioKey) {
    if (!window.confirm(`Revoke receiver key "${key.name}"? Active SDRTrunk uploads using it will be rejected.`)) return;
    try { await request(`/radio-keys/${key.id}`, token, { method: 'DELETE' }); await loadSupportData(); setNotice('Receiver key revoked'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Receiver key not revoked'); }
  }

  async function copyRadioKey() {
    try { await navigator.clipboard.writeText(createdRadioKey); setNotice('Receiver key copied'); }
    catch { setNotice('Clipboard access was denied. Select the displayed key and copy it manually.'); }
  }

  async function toggleImage(image: ImageRecord) {
    try { await request(`/images/${image.id}`, token, { method: 'PATCH', body: JSON.stringify({ enabled: !image.enabled }) }); await loadSupportData(); setNotice('Image bank updated'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Image not updated'); }
  }

  async function addImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try { await request('/images', token, { method: 'POST', body: form }); event.currentTarget.reset(); await loadSupportData(); setNotice('Image added to the configured bank'); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Image upload failed'); }
  }

  if (!token || !user) return <main className="login-screen"><form className="login-panel" onSubmit={login}>
    <div className="brand-lockup"><span className="brand-mark"><Radio size={20}/></span><span>SIGNAL<span className="brand-light">DESK</span></span></div>
    <p className="eyebrow">RADIO INCIDENT REVIEW</p><h1>Sign in</h1><p className="muted">Use your assigned workspace account.</p>
    <label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)}/></label>
    <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)}/></label>
    {loginError && <p role="alert" className="form-error">{loginError}</p>}<button className="primary full-width" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}<ChevronRight size={17}/></button>
  </form></main>;

  const openIncidents = incidents.filter(item => !['published','rejected'].includes(item.status));
  const callIncidents = openIncidents.filter(item => item.priority === 'high' || item.priority === 'medium');
  const visibleIncidents = tab === 'calls' ? callIncidents : tab === 'queue' ? openIncidents : incidents;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to incidents</a>
    <header className="topbar">
      <a className="brand-lockup" href="#" aria-label="Signal Desk home" onClick={event => { event.preventDefault(); setTab('queue'); selectIncident(''); }}><span className="brand-mark"><Radio size={20}/></span><span>SIGNAL<span className="brand-light">DESK</span></span></a>
      <div className="topbar-center"><span className={serviceStatus.apiOnline?'live-indicator':'service-indicator-off'} aria-hidden="true"/><span>API / QUEUE</span><strong>{serviceStatus.apiOnline?'READY':'OFFLINE'}</strong></div>
      <div className="account"><span className="account-role">{user.role}</span><span className="account-email">{user.email}</span><button className="icon-button" title="Sign out" aria-label="Sign out" onClick={() => { localStorage.removeItem('signal-token'); setToken(''); }}><LogOut size={17}/></button></div>
    </header>
    <div className="workspace">
      <nav className="rail" aria-label="Primary navigation">
        <button className={tab==='calls'?'rail-button active':'rail-button'} onClick={() => setTab('calls')}><CircleAlert size={18}/><span>Calls</span><b>{callIncidents.length}</b></button>
        <button className={tab==='queue'?'rail-button active':'rail-button'} onClick={() => setTab('queue')}><Activity size={18}/><span>All Traffic</span></button>
        <button className={tab==='history'?'rail-button active':'rail-button'} onClick={() => setTab('history')}><History size={18}/><span>History</span></button>
        <button className={tab==='receiver'?'rail-button active':'rail-button'} onClick={() => setTab('receiver')}><Terminal size={18}/><span>Receiver monitor</span></button>
        {isAdmin && <button className={tab==='settings'?'rail-button active':'rail-button'} onClick={() => setTab('settings')}><Settings2 size={18}/><span>Configuration</span></button>}
        {isAdmin && <button className={tab==='audit'?'rail-button active':'rail-button'} onClick={() => setTab('audit')}><ShieldCheck size={18}/><span>Audit log</span></button>}
        <div className="rail-foot"><div className="service-state"><span className={serviceStatus.workerOnline?'':'offline'}/><div><strong>PROCESSING</strong><small>{serviceStatus.workerOnline?'Workers online':'Worker unavailable'}</small></div></div><p>PRIVATE REVIEW WORKSPACE</p></div>
      </nav>

      <main id="main-content" className="main-area">
        {tab === 'settings' ? <section className="settings-page">
          <div className="page-heading"><div><p className="eyebrow">ADMINISTRATION</p><h1>Configuration</h1></div><span className="role-chip">ADMIN ONLY</span></div>
          <section className="settings-section"><div className="section-heading"><div><h2>Discovered talkgroups</h2><p>Automatically listed from received Rdio Scanner calls; no separate setup is required.</p></div></div>
            <div className="data-table">{talkgroups.map(group=><div className="table-row discovered-talkgroup" key={group.id}><code>{group.id}</code><strong>{group.label}</strong><span className="status-text good">Discovered</span></div>)}{talkgroups.length===0 && <p className="muted">Talkgroups will appear here when the receiver sends calls.</p>}</div>
          </section>
          <section className="settings-section"><div className="section-heading"><div><h2>Rdio Scanner receiver keys</h2><p>Keys are restricted to one System ID and accept every talkgroup sent by Rdio Scanner.</p></div></div>
            <form className="inline-form receiver-key-form" onSubmit={createRadioKey}><label>Key name<input required value={newRadioKey.name} onChange={event=>setNewRadioKey({...newRadioKey,name:event.target.value})} placeholder="Dispatch console"/></label><label>System ID<input type="number" min="1" step="1" required value={newRadioKey.systemId} onChange={event=>setNewRadioKey({...newRadioKey,systemId:event.target.value})} placeholder="1"/></label><button className="primary"><ShieldCheck size={16}/>Generate key</button></form>
            {createdRadioKey && <div className="new-key-reveal" role="status"><div><strong>New key</strong><small>Copy now. It will not be displayed again.</small></div><code>{createdRadioKey}</code><button className="secondary" onClick={()=>void copyRadioKey()}>Copy key</button><button className="icon-button" title="Hide key" aria-label="Hide generated key" onClick={()=>setCreatedRadioKey('')}><X size={16}/></button></div>}
            <div className="radio-key-list">{radioKeys.map(key=><div className="radio-key-row" key={key.id}><div><strong>{key.name}</strong><small>System {key.system_id} · All talkgroups</small><small>{key.last_used_at ? `Last used ${new Date(key.last_used_at).toLocaleString()}` : `Created ${new Date(key.created_at).toLocaleString()}`}</small></div><span className={key.enabled?'status-text good':'status-text'}>{key.enabled?'Active':'Revoked'}</span>{key.enabled && <button className="table-action" onClick={()=>void revokeRadioKey(key)}>Revoke</button>}</div>)}</div>
          </section>
          <section className="settings-section"><div className="section-heading"><div><h2>Location image bank</h2><p>Only these configured images can be attached to a post.</p></div></div>
            <form className="inline-form image-form" onSubmit={addImage}><label>Image file<input type="file" name="file" accept="image/png,image/jpeg,image/webp" required/></label><label>Image name<input name="name" placeholder="Fulton.png" required/></label><label>Location<input name="location" placeholder="Fulton County" required/></label><button className="secondary"><ImagePlus size={16}/>Add image</button></form>
            <div className="image-bank">{images.map(image=><div className="image-bank-item" key={image.id}><div className="image-swatch"><ImagePlus size={18}/></div><div><strong>{image.name}</strong><small>{image.location}</small></div><button className="table-action" onClick={()=>toggleImage(image)}>{image.enabled?'Disable':'Enable'}</button></div>)}</div>
          </section>
          <p className="settings-note"><SlidersHorizontal size={16}/> Tone frequencies, correlation window, AI provider, and Facebook credentials are managed in the deployment environment.</p>
        </section> : tab === 'audit' ? <AuditPanel token={token}/> : tab === 'receiver' ? <ReceiverMonitor token={token}/> : <>
          <div className="page-heading"><div><p className="eyebrow">{tab==='calls'?'HIGH / MEDIUM PRIORITY':tab==='queue'?'ALL RECEIVED TRAFFIC':'RECORDS / SEARCH'}</p><h1>{tab==='calls'?'Calls':tab==='queue'?'All Traffic':'Incident history'}</h1></div><div className="heading-actions"><span className="sync-stamp"><span className="live-indicator"/>Updates every 8 seconds</span>{canReview && <button ref={manualButtonRef} className="primary" onClick={()=>setModal(true)}><FilePlus2 size={16}/>New manual post</button>}</div></div>
          <div className="metrics-row"><div><span>HIGH PRIORITY</span><strong>{openIncidents.filter(item=>item.priority==='high').length}</strong></div><div><span>MEDIUM PRIORITY</span><strong>{openIncidents.filter(item=>item.priority==='medium').length}</strong></div><div><span>LOW TRAFFIC</span><strong>{openIncidents.filter(item=>item.priority==='low').length}</strong></div><div><span>PROCESSING</span><strong>{counts.processing ?? 0}</strong></div></div>
          <div className="content-grid">
            <section className="incident-list" aria-label="Incidents">
              <div className="list-tools"><label className="search-box"><Search size={16}/><input aria-label="Search incidents" placeholder="Search calls, locations..." value={search} onChange={event=>setSearch(event.target.value)}/></label>
                <label className="visually-hidden" htmlFor="status-filter">Filter by status</label><select id="status-filter" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}><option value="">All statuses</option>{Object.entries(statusLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
                <label className="visually-hidden" htmlFor="talkgroup-filter">Filter by talkgroup</label><select id="talkgroup-filter" value={talkgroupFilter} onChange={event=>setTalkgroupFilter(event.target.value)}><option value="">All talkgroups</option>{talkgroups.map(group=><option key={group.id} value={group.id}>{group.label}</option>)}</select>
              </div>
              <div className="list-count" aria-live="polite" aria-atomic="true"><span>{visibleIncidents.length} INCIDENTS</span><span>NEWEST FIRST</span></div>
              <div className="incident-items">{visibleIncidents.map(item=><button key={item.id} className={`incident-row ${selectedId===item.id?'selected':''}`} onClick={()=>selectIncident(item.id)} aria-current={selectedId===item.id?'true':undefined}>
                <span className={`status-marker ${item.priority}`} aria-hidden="true"/><span className="incident-copy"><span className="incident-line"><strong>{item.public_data?.call || (item.event_type==='tone'?'Page tone detected':'Radio call details pending')}</strong><span className={`priority-pill ${item.priority}`}>{item.priority}</span><span className={`status-pill ${item.status}`}>{statusLabels[item.status] ?? item.status}</span></span><span className="incident-subline">{item.talkgroup_label} <span>·</span> {item.public_data?.location || 'Location pending'}</span><span className="incident-time"><Clock3 size={12}/>{new Date(item.received_at).toLocaleString()}</span></span><ChevronRight className="row-chevron" size={16}/>
              </button>)}{visibleIncidents.length===0 && <div className="empty-list"><AudioLines size={25}/><strong>{tab==='calls'?'No high- or medium-priority calls':'No matching incidents'}</strong><span>{tab==='calls'?'Urgent and response-request calls appear here.':'Incoming Rdio Scanner calls appear here as they arrive.'}</span></div>}</div>
            </section>
            <section className="detail-panel" aria-label="Incident review">
              {detail ? <>
                <div className="detail-header"><div><p className="eyebrow">{detail.talkgroup_label} / {detail.event_type.toUpperCase()}</p><h2>{detail.public_data?.call || 'Incident details'}</h2><p className="detail-time">Received {new Date(detail.received_at).toLocaleString()}</p></div><span className={`status-pill large ${detail.status}`}>{statusLabels[detail.status] ?? detail.status}</span></div>
                {canReview && <label className="internal-priority">Internal priority<select value={detail.priority} onChange={event=>void changePriority(event.target.value as Summary['priority'])} disabled={busy}><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select><small>Internal triage only; not included in the public post.</small></label>}
                {detail.publish_error && <div className="warning-banner" role="alert"><CircleAlert size={17}/><span>{detail.publish_error}</span></div>}
                {detail.status==='publish_unknown' && <div className="reconcile-panel"><div className="warning-banner" role="alert"><CircleAlert size={17}/><span>Facebook's response was inconclusive. Do not retry until the Page has been checked.</span></div>{isAdmin && <><form className="reconcile-form" onSubmit={event=>{event.preventDefault();if(reconcilePostId.trim())void resolvePublication(reconcilePostId.trim());}}><label>Facebook post ID, if published<input value={reconcilePostId} onChange={event=>setReconcilePostId(event.target.value)} maxLength={200}/></label><button className="secondary" disabled={busy || !reconcilePostId.trim()}>Record published post</button></form><button className="reject-button" disabled={busy} onClick={()=>void resolvePublication()}>Confirm not published</button></>}</div>}
                {canReview && typeof detail.source_metadata?.processingError === 'string' && <div className="warning-banner" role="alert"><CircleAlert size={17}/><span>{detail.source_metadata.processingError}</span><button className="table-action" onClick={()=>perform(`/incidents/${detail.id}/reprocess`,'POST',{},'Audio processing queued again')}>Retry processing</button></div>}
                {canReview && <section className="detail-section audio-section"><div className="section-heading compact"><div><h3><AudioLines size={17}/> Recording</h3><p>Private reviewer access</p></div>{detail.originalUrl && <a className="text-link" href={originalObjectUrl || undefined} aria-disabled={!originalObjectUrl} download>Original audio</a>}</div>
                  {detail.audioUrl ? playableObjectUrl ? <audio controls preload="none" src={playableObjectUrl}>Audio playback is not supported in this browser.</audio> : <div className="no-audio">Loading private recording...</div> : <div className="no-audio">{detail.status==='processing'?'Waiting for audio processing':'No playable audio attached'}</div>}
                  {!['published','publish_queued'].includes(detail.status) && <label className="upload-control"><Upload size={15}/><span>Upload audio</span><input type="file" accept="audio/*" onChange={uploadAudio} disabled={busy}/></label>}
                </section>}
                <section className="detail-section"><div className="section-heading compact"><div><h3>Public post</h3><p>{detail.event_type==='manual'?'Manual entry · privacy filters not applied':'Application-rendered format · address and sensitivity checks applied'}</p></div>{detail.status==='published' && <span className="published-id">FB {detail.facebook_post_id}</span>}</div>
                  <fieldset className="editor-fieldset" disabled={!canReview || detail.status==='publish_unknown'}><div className="editor-grid"><label>Jurisdiction<input value={postDraft.jurisdiction} onChange={e=>setPostDraft({...postDraft,jurisdiction:e.target.value})}/></label><label>Call<input value={postDraft.call} onChange={e=>setPostDraft({...postDraft,call:e.target.value})}/></label><label className="span-two">Location / intersection<input value={postDraft.location} onChange={e=>setPostDraft({...postDraft,location:e.target.value})}/></label><label>Time received<input value={postDraft.timeReceived} onChange={e=>setPostDraft({...postDraft,timeReceived:e.target.value})}/></label><label>Sensitivity<select value={postDraft.sensitivity} onChange={e=>setPostDraft({...postDraft,sensitivity:e.target.value as PublicPost['sensitivity']})}><option value="low">Low</option><option value="moderate">Moderate</option><option value="high">High · details hidden</option></select></label>
                    <label className="span-two">Extra information<input value={postDraft.extraInfo} onChange={e=>setPostDraft({...postDraft,extraInfo:e.target.value})} placeholder="Disabled unless configured by administrator"/></label>
                    <label className="span-two">Configured location image<select value={imageId} onChange={e=>setImageId(e.target.value)}><option value="">No image</option>{images.filter(image=>image.enabled).map(image=><option key={image.id} value={image.id}>{image.name} · {image.location}</option>)}</select></label>
                    <label className="span-two audio-share-option"><input type="checkbox" checked={postDraft.includeAudio} onChange={e=>setPostDraft({...postDraft,includeAudio:e.target.checked})}/><span>Include audio link on Facebook</span></label>
                  </div></fieldset>
                  <div className="post-preview"><div className="preview-label"><span>PUBLIC PREVIEW</span><span>FACEBOOK</span></div><pre>{postPreview}</pre>{imagePreview && <img className="preview-image" src={imagePreview} alt={`Selected image: ${images.find(image=>image.id===imageId)?.name ?? ''}`}/ >}{postDraft.includeAudio && detail.publicAudioUrl && <a href={detail.publicAudioUrl} className="audio-public-link">Public audio link <ChevronRight size={14}/></a>}</div>
                  {canReview && <div className="review-actions"><button className="secondary" disabled={busy || ['processing','published','publish_queued','publish_unknown'].includes(detail.status)} onClick={savePost}>Save draft</button><button className="reject-button" disabled={busy || ['processing','published','publish_queued','publish_unknown','rejected'].includes(detail.status)} onClick={()=>perform(`/incidents/${detail.id}/reject`,'POST',{reason:''},'Incident rejected')}>Reject</button>{detail.status==='approved'||detail.status==='publish_failed' ? <button className="primary" disabled={busy} onClick={()=>perform(`/incidents/${detail.id}/publish`,'POST',{},'Publication queued')}>{detail.status==='publish_failed'?'Retry Facebook':'Publish to Facebook'}<ChevronRight size={16}/></button> : <button className="approve-button" disabled={busy || detail.status==='processing' || !postDraft.jurisdiction.trim() || !postDraft.call.trim() || (detail.event_type !== 'manual' && !detail.audioUrl) || ['published','publish_queued','publish_unknown','rejected'].includes(detail.status)} onClick={approvePost}>Approve draft<Check size={16}/></button>}</div>}
                </section>
                {canReview && <section className="detail-section"><details><summary>Internal review data</summary><div className="internal-grid"><div><h4>Transcript</h4><p className="transcript-text">{detail.transcript || 'No transcript available.'}</p></div><div><h4>Private extraction</h4><pre>{JSON.stringify(detail.internal_data ?? {}, null, 2)}</pre></div></div></details></section>}
                <section className="detail-section"><details><summary>Audit history <span className="count-badge">{detail.audit?.length ?? 0}</span></summary><div className="audit-list">{detail.audit?.map((entry,index)=><div key={`${entry.created_at}-${index}`}><strong>{entry.action}</strong><time>{new Date(entry.created_at).toLocaleString()}</time><small>{entry.email ?? 'System'}</small><pre>{JSON.stringify(entry.details, null, 2)}</pre></div>)}</div></details></section>
              </> : <div className="detail-empty"><div className="empty-symbol"><Radio size={26}/></div><p className="eyebrow">REVIEW WORKSPACE</p><h2>Select an incident</h2><p>Choose a call from the queue to inspect its recording, review sanitized details, and prepare a post.</p></div>}
            </section>
          </div>
        </>}
      </main>
    </div>
    {notice && <div className="toast" role="status"><span>{notice}</span><button aria-label="Dismiss message" onClick={()=>setNotice('')}><X size={15}/></button></div>}
    {modal && <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setModal(false);}}><section ref={modalRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="manual-title"><div className="modal-heading"><div><p className="eyebrow">REVIEWER CREATED</p><h2 id="manual-title">New manual post</h2></div><button className="icon-button" aria-label="Close dialog" onClick={()=>setModal(false)}><X size={18}/></button></div>
      <form onSubmit={createManualPost}><label>Talkgroup<input name="talkgroupId" list="known-talkgroups" required placeholder="Enter talkgroup ID"/><datalist id="known-talkgroups">{talkgroups.map(tg=><option key={tg.id} value={tg.id}>{tg.label}</option>)}</datalist></label>
        <label>Jurisdiction<input required value={newPost.jurisdiction} onChange={e=>setNewPost({...newPost,jurisdiction:e.target.value})}/></label><label>Call<input required value={newPost.call} onChange={e=>setNewPost({...newPost,call:e.target.value})}/></label><label>Location / intersection<input value={newPost.location} onChange={e=>setNewPost({...newPost,location:e.target.value})}/></label><label>Time received<input value={newPost.timeReceived} onChange={e=>setNewPost({...newPost,timeReceived:e.target.value})}/></label>
        <div className="modal-actions"><button type="button" className="secondary" onClick={()=>setModal(false)}>Cancel</button><button className="primary" disabled={busy}>Create draft<ChevronRight size={16}/></button></div>
      </form></section></div>}
  </div>;
}

function AuditPanel({ token }: { token: string }) {
  const [entries, setEntries] = useState<{id:number;email:string|null;action:string;details:Record<string,unknown>;created_at:string}[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { request<{entries:typeof entries}>('/audit?limit=200',token).then(result=>setEntries(result.entries)).catch(reason=>setError(reason.message)); }, [token]);
  return <section className="settings-page"><div className="page-heading"><div><p className="eyebrow">ADMINISTRATION</p><h1>Audit log</h1></div></div><section className="settings-section"><div className="section-heading"><div><h2>Recent activity</h2><p>Approval, edits, administration, and publication actions.</p></div></div>{error && <p role="alert" className="form-error">{error}</p>}<div className="audit-list full-audit">{entries.map(entry=><div key={entry.id}><span className="audit-dot"/><strong>{entry.action}</strong><span>{entry.email ?? 'System'}</span><time>{new Date(entry.created_at).toLocaleString()}</time><details><summary>Details</summary><pre>{JSON.stringify(entry.details,null,2)}</pre></details></div>)}</div></section></section>;
}

function ReceiverMonitor({ token }: { token: string }) {
  const [entries, setEntries] = useState<ReceiverRequest[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let afterId = 0;
    const poll = async () => {
      try {
        const result = await request<{ requests: ReceiverRequest[] }>(`/receiver-requests?afterId=${afterId}&limit=100`, token);
        if (!active) return;
        if (result.requests.length) {
          afterId = Number(result.requests.at(-1)!.id);
          setEntries(current => [...current, ...result.requests].slice(-500));
        }
        setConnected(true);
        setError('');
      } catch (reason) {
        if (active) { setConnected(false); setError(reason instanceof Error ? reason.message : 'Monitor unavailable'); }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => { active = false; window.clearInterval(timer); };
  }, [token]);

  return <section className="receiver-monitor-page">
    <div className="page-heading"><div><p className="eyebrow">RDIO SCANNER / INPUT</p><h1>Receiver monitor</h1></div><span className={connected ? 'monitor-connection connected' : 'monitor-connection'}><span/>{connected ? 'LIVE' : 'RECONNECTING'}</span></div>
    <div className="receiver-terminal" aria-label="Read-only Rdio Scanner request log">
      <div className="receiver-terminal-head"><span>READ-ONLY REQUEST STREAM</span><span>LAST {entries.length} / 500</span></div>
      <div className="receiver-terminal-lines" aria-live="polite" aria-relevant="additions">
        {entries.map(entry => <div className="receiver-terminal-line" key={entry.id}>
          <time>{new Date(entry.received_at).toLocaleTimeString()}</time>
          <strong className={entry.status_code < 400 ? 'request-status accepted' : 'request-status rejected'}>{entry.status_code}</strong>
          <code>{entry.method} {entry.path}</code>
          <span className="request-scope">SYS {entry.system_id ?? '--'} / TG {entry.talkgroup_id ?? '--'}</span>
          <span className="request-summary">{entry.summary}{typeof entry.details.audioBytes === 'number' && entry.details.audioBytes > 0 ? ` · ${entry.details.audioBytes.toLocaleString()} bytes` : ''}</span>
        </div>)}
        {!entries.length && <p className="receiver-terminal-empty">{error || 'Waiting for Rdio Scanner requests...'}</p>}
      </div>
    </div>
    {error && entries.length > 0 && <p className="monitor-error" role="status">Monitor reconnecting: {error}</p>}
  </section>;
}