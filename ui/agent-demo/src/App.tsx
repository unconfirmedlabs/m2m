import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { DemoApi, DemoApiError } from './api.js';
import { deriveEconomy, formatMist, formatSui } from './accounting.js';
import { applyDemoEvent, clearNewActivity, clearRefreshRequest, initialUiState, replaceSnapshot, setBrowserState } from './reducer.js';
import type { DemoCommand, DemoControl, DemoControlRecord, DemoSnapshot, MachineRole } from './types.js';
import type { DemoEvent } from './types.js';
import './styles.css';

const api = new DemoApi();

function randomId(): string {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function isAvailable(snapshot: DemoSnapshot | null, op: DemoCommand['op']): boolean {
  return !!snapshot?.available_controls.includes(op);
}

function codeOf(error: unknown): string {
  return error instanceof DemoApiError ? error.code : 'network_unavailable';
}

function shortAddress(address: string): string { return `${address.slice(0, 10)}…${address.slice(-8)}`; }

function App() {
  const [state, dispatch] = useReducer((current: ReturnType<typeof initialUiState>, action: { type: string; snapshot?: DemoSnapshot; event?: DemoEvent; browser?: ReturnType<typeof initialUiState>['browser']; error?: string }) => {
    if (action.type === 'snapshot' && action.snapshot) return replaceSnapshot(current, action.snapshot);
    if (action.type === 'event' && action.event) return applyDemoEvent(current, action.event);
    if (action.type === 'browser') return setBrowserState(current, action.browser ?? 'failed', action.error ?? null);
    if (action.type === 'clearActivity') return clearNewActivity(current);
    if (action.type === 'clearRefresh') return clearRefreshRequest(current);
    if (action.type === 'reset') return initialUiState();
    return current;
  }, initialUiState());
  const [tokenInput, setTokenInput] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Record<string, DemoControlRecord>>({});
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [access, setAccess] = useState<'viewer' | 'operator'>('viewer');
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const subscription = useRef<{ abort(): void } | null>(null);
  const pendingIntents = useRef(new Map<string, DemoControl>());
  const refreshInFlight = useRef(false);
  const latestSequence = useRef('0');
  const sessionGeneration = useRef(0);

  const resetSession = useCallback(() => {
    sessionGeneration.current += 1;
    subscription.current?.abort(); subscription.current = null; api.logout();
    pendingIntents.current.clear(); setPending({}); setPrompt(''); setNotice(null); setLoginError(null);
    latestSequence.current = '0'; setAuthenticated(false); setAccess('viewer'); setSelectedChannel(null); dispatch({ type: 'reset' });
  }, []);

  useEffect(() => {
    api.setUnauthorizedHandler(resetSession);
    return () => api.setUnauthorizedHandler(null);
  }, [resetSession]);

  const loadSession = useCallback(async () => {
    const session = await api.session();
    if (session.access !== 'viewer' && session.access !== 'operator') throw new DemoApiError(502, 'invalid_session');
    setAuthenticated(true);
    setAccess(session.access);
    setSelectedChannel(session.snapshot.selected_channel ?? session.snapshot.channels[0]?.channel ?? null);
    latestSequence.current = session.snapshot.projection_sequence;
    dispatch({ type: 'snapshot', snapshot: session.snapshot });
    subscription.current?.abort();
    // The initial authenticated view must replay history, not only events after
    // the snapshot high-water; subsequent reconnects use the local cursor.
    const replay = { coordinator: '0', research: '0', host: '0' } as const;
    subscription.current = api.subscribe(replay, event => {
      if (BigInt(event.sequence) > BigInt(latestSequence.current)) latestSequence.current = event.sequence;
      dispatch({ type: 'event', event });
    }, (status, error) => dispatch({ type: 'browser', browser: status, error }), undefined, `${session.snapshot.conversation}:0`);
  }, []);

  useEffect(() => () => { subscription.current?.abort(); api.logout(); }, []);

  useEffect(() => {
    if (!authenticated || !state.refreshRequested || refreshInFlight.current) return;
    refreshInFlight.current = true; dispatch({ type: 'clearRefresh' });
    const generation = sessionGeneration.current;
    void api.status().then(async snapshot => {
      if (generation !== sessionGeneration.current) return;
      dispatch({ type: 'snapshot', snapshot });
      // An event may have arrived while this finite refresh was in flight.
      // Re-read once at the newer cut so the committed snapshot cannot erase
      // the already observed S+1 activity. Any still-later event leaves the
      // reducer's refreshRequested latch set for the next pass.
      if (BigInt(latestSequence.current) > BigInt(snapshot.projection_sequence)) {
        const followup = await api.status();
        if (generation === sessionGeneration.current) dispatch({ type: 'snapshot', snapshot: followup });
      }
    }).catch(error => {
      if (generation !== sessionGeneration.current) return;
      if (error instanceof DemoApiError && error.status === 401) return;
      setNotice(codeOf(error));
    }).finally(() => { refreshInFlight.current = false; });
  }, [authenticated, state.refreshRequested]);

  useEffect(() => {
    if (!authenticated || !state.snapshot || (state.browser !== 'failed' && state.browser !== 'disconnected')) return;
    const timer = window.setTimeout(() => {
      if (!state.snapshot) return;
      const cursor = state.snapshot.roles.coordinator.cursor;
      subscription.current = api.subscribe(cursor, event => {
        if (BigInt(event.sequence) > BigInt(latestSequence.current)) latestSequence.current = event.sequence;
        dispatch({ type: 'event', event });
      }, (status, error) => dispatch({ type: 'browser', browser: status, error }), undefined, `${state.snapshot.conversation}:${state.lastSequence}`);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [authenticated, state.browser, state.lastSequence, state.snapshot]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault(); setLoginError(null);
    try { sessionGeneration.current += 1; api.authenticate(tokenInput.trim()); await loadSession(); setTokenInput(''); }
    catch (error) { api.logout(); setLoginError(codeOf(error)); }
  };

  const logout = () => { resetSession(); };

  const send = async (command: DemoCommand, id?: string) => {
    const generation = sessionGeneration.current;
    const key = JSON.stringify(command);
    const control = pendingIntents.current.get(key) ?? { version: 1, id: id ?? randomId(), command };
    pendingIntents.current.set(key, control);
    setBusy(true); setNotice(null);
    try {
      let record: DemoControlRecord;
      try { record = await api.control(control); }
      catch (error) {
        // A lost POST response is recovered by the exact durable command ID;
        // if the server has not seen it yet, the intent remains for the next
        // click and is never replaced with a fresh command.
        if (error instanceof DemoApiError && (error.status === 0 || error.status >= 500)) {
          try { record = await api.controlStatus(control.id, control.command); }
          catch { throw error; }
        } else throw error;
      }
      if (generation !== sessionGeneration.current) return;
      setPending(previous => ({ ...previous, [control.id]: record }));
      let polls = 0;
      while (record.state === 'accepted' || record.state === 'running') {
        if (polls++ >= 120) { setNotice('control_status_timeout'); return; }
        await new Promise(resolve => window.setTimeout(resolve, 500));
        record = await api.controlStatus(control.id, control.command);
        if (generation !== sessionGeneration.current) return;
        setPending(previous => ({ ...previous, [control.id]: record }));
      }
      if (record.state === 'uncertain') {
        setNotice('operation_uncertain_replay_same_intent');
        return;
      }
      pendingIntents.current.delete(key);
      const fresh = await api.status(); dispatch({ type: 'snapshot', snapshot: fresh });
    } catch (error) { if (generation === sessionGeneration.current) setNotice(codeOf(error)); }
    finally { if (generation === sessionGeneration.current) setBusy(false); }
  };

  if (!authenticated || !state.snapshot) return <LoginScreen token={tokenInput} setToken={setTokenInput} onSubmit={login} error={loginError} />;
  return <Dashboard access={access} selectedChannel={selectedChannel} setSelectedChannel={setSelectedChannel} state={state} prompt={prompt} setPrompt={setPrompt} busy={busy} pending={pending} notice={notice} onSend={send} onLogout={logout} />;
}

function LoginScreen({ token, setToken, onSubmit, error }: { token: string; setToken(value: string): void; onSubmit(event: React.FormEvent): void; error: string | null }) {
  return <main className="min-h-screen bg-ink px-5 py-10 text-slate-100 sm:px-10">
    <section className="mx-auto flex min-h-[72vh] max-w-xl flex-col justify-center">
      <p className="eyebrow">M2M / LIVE EXCHANGE</p>
      <h1 className="mt-4 max-w-lg text-5xl font-semibold tracking-[-0.05em] text-white sm:text-7xl">Research that can show its receipts.</h1>
      <p className="mt-6 max-w-md text-base leading-7 text-slate-400">Authenticate to observe the real coordinator, research provider, transport and cumulative channel evidence.</p>
      <form onSubmit={onSubmit} className="mt-10 max-w-md space-y-3">
        <label className="field-label" htmlFor="access-token">Viewer or operator token</label>
        <input id="access-token" aria-describedby={error ? 'login-error' : undefined} className="input" type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required />
        <button className="button button-primary w-full" type="submit">Open live session</button>
        {error && <p id="login-error" role="alert" className="error-text">{error}</p>}
      </form>
    </section>
  </main>;
}

function Dashboard({ access, selectedChannel, setSelectedChannel, state, prompt, setPrompt, busy, pending, notice, onSend, onLogout }: {
  access: 'viewer' | 'operator';
  selectedChannel: string | null; setSelectedChannel(value: string): void;
  state: ReturnType<typeof initialUiState>; prompt: string; setPrompt(value: string): void; busy: boolean; pending: Record<string, DemoControlRecord>; notice: string | null;
  onSend(command: DemoCommand, id?: string): Promise<void>; onLogout(): void;
}) {
  const snapshot = state.snapshot!;
  const activeTask = snapshot.roles.coordinator.active_task;
  const selected = snapshot.channels.find(channel => channel.channel === selectedChannel) ?? snapshot.channels[0];
  const economy = selected ? deriveEconomy(selected) : null;
  const isViewer = access === 'viewer';
  const can = (op: DemoCommand['op']) => !isViewer && state.sync === 'live' && isAvailable(snapshot, op);
  const latestPending = Object.values(pending).at(-1);
  return <main className="min-h-screen bg-paper text-ink">
    <header className="border-b border-slate-200 bg-white/90 px-5 py-4 backdrop-blur sm:px-8">
      <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4">
        <div><p className="eyebrow text-coral">M2M / LIVE EXCHANGE</p><h1 className="mt-1 text-xl font-semibold tracking-tight">Nozomi research desk</h1></div>
        <div className="flex items-center gap-3"><ConnectionPill label="Browser" value={state.browser} /><button className="button button-quiet" onClick={onLogout}>Lock session</button></div>
      </div>
    </header>
    <section className="mx-auto max-w-[1500px] px-5 py-5 sm:px-8">
      <ChannelStrip economy={economy} snapshot={snapshot} selectedChannel={selected?.channel ?? null} onSelect={setSelectedChannel} />
      <section className="mt-5 grid gap-5 lg:grid-cols-2">
        <AgentPanel role="coordinator" snapshot={snapshot} state={state} />
        <AgentPanel role="provider" snapshot={snapshot} state={state} />
      </section>
      <section className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_0.6fr]">
        <div className="card">
          <div className="flex items-start justify-between gap-4"><div><p className="eyebrow">Operator controls</p><h2 className="section-title">Choose the next real operation</h2></div><span className="status-dot"><i />{snapshot.roles.coordinator.phase}</span></div>
          <label htmlFor="task-prompt" className="field-label mt-6">Unseen task prompt</label>
          <textarea id="task-prompt" className="input min-h-24 resize-y" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Ask the coordinator to investigate something…" />
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="button button-primary" disabled={!can('task') || !prompt.trim()} onClick={() => { void onSend({ op: 'task', prompt }); }}>Send task</button>
            <button className="button" disabled={!can('start')} onClick={() => void onSend({ op: 'start' })}>Start / reconnect</button>
            <button className="button" disabled={!can('fund')} onClick={() => void onSend({ op: 'fund', configuration_hash: snapshot.configuration_hash, previous_channel: snapshot.selected_channel })}>Fund displayed terms</button>
            <button className="button button-danger" disabled={!can('cancel') || !activeTask} onClick={() => void onSend({ op: 'cancel', task: activeTask ?? '' })}>Cancel active task</button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="button button-small" disabled={!can('spending')} onClick={() => void onSend({ op: 'spending', paused: !snapshot.roles.coordinator.spending_paused })}>{snapshot.roles.coordinator.spending_paused ? 'Resume spending' : 'Pause spending'}</button>
            <button className="button button-small" disabled={!can('disconnect')} onClick={() => void onSend({ op: 'disconnect' })}>Disconnect Iroh</button>
            <button className="button button-small" disabled={!can('reconnect')} onClick={() => void onSend({ op: 'reconnect' })}>Reconnect Iroh</button>
            {selected && <><button className="button button-small" disabled={!can('close')} onClick={() => void onSend({ op: 'close', channel: selected.channel })}>Close channel</button><button className="button button-small" disabled={!can('refund')} onClick={() => void onSend({ op: 'refund', channel: selected.channel })}>Refund when eligible</button></>}
          </div>
          <p className="mt-4 text-xs text-slate-500">Controls remain available during a durable operation so cancellation and spending pause are not stranded behind a lost response.</p>
          {latestPending && <p className="mt-4 rounded-xl bg-slate-100 px-3 py-2 text-sm text-slate-600">Operation <code>{latestPending.id.slice(0, 10)}…</code> is {latestPending.state}{latestPending.code ? ` · ${latestPending.code}` : ''}.</p>}
          {notice && <p className="mt-3 error-text" role="alert">{notice}</p>}
        </div>
        <div className="card">
          <p className="eyebrow">Activity integrity</p><h2 className="section-title">Durable event view</h2>
          <dl className="mt-5 space-y-3 text-sm"><Metric label="Projection sequence" value={snapshot.projection_sequence} /><Metric label="Browser stream" value={state.browser} /><Metric label="History cut" value={state.replayCut ?? 'unknown'} /><Metric label="Synchronization" value={state.sync} /><Metric label="Iroh / coordinator" value={state.iroh.coordinator} /><Metric label="Iroh / research" value={state.iroh.provider} /><Metric label="Last received event" value={state.lastSequence} /></dl>
          {state.browserError && <p className="mt-5 error-text">Stream: {state.browserError}</p>}
          <button className="button button-quiet mt-5" disabled={!state.newActivity} onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })}>Jump to new activity</button>
        </div>
      </section>
    </section>
  </main>;
}

function ChannelStrip({ economy, snapshot, selectedChannel, onSelect }: { economy: ReturnType<typeof deriveEconomy> | null; snapshot: DemoSnapshot; selectedChannel: string | null; onSelect(value: string): void }) {
  return <section className="channel-strip" aria-label="Selected channel accounting">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="eyebrow text-coral">Selected channel</p><h2 className="mt-1 text-lg font-semibold">{economy ? shortAddress(economy.economy.channel) : 'No channel selected'}</h2><p className="mt-1 text-xs text-slate-500">{economy ? `${economy.economy.status} · observed ${economy.economy.observed_at_ms ?? 'unknown'}` : 'Funding is an explicit operator action.'}</p></div><div className="flex items-center gap-2">{snapshot.channels.length > 1 && <label className="sr-only" htmlFor="channel-history">Channel history</label>}{snapshot.channels.length > 1 && <select id="channel-history" className="input !w-auto !py-2 text-xs" value={selectedChannel ?? ''} onChange={event => onSelect(event.target.value)}>{snapshot.channels.map(channel => <option key={channel.channel} value={channel.channel}>{shortAddress(channel.channel)} · {channel.status}</option>)}</select>}{economy && <span className="badge">{economy.economy.status}</span>}</div></div>
    {economy ? <div className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-slate-200 sm:grid-cols-4 lg:grid-cols-8">
      <MoneyMetric label="Deposit" value={formatMist(economy.economy.offer.payload.deposit)} />
      <MoneyMetric label="Signed max" value={formatMist(economy.signedAuthorization)} detail={formatSui(economy.signedAuthorization)} />
      <MoneyMetric label="Reserved max" value={formatMist(economy.economy.reserved_mist)} detail={formatSui(economy.economy.reserved_mist)} />
      <MoneyMetric label="Delivered price" value={formatMist(economy.deliveredPrice)} detail={economy.priceMismatch ? 'evidence mismatch' : 'policy exact'} />
      <MoneyMetric label="Outstanding" value={formatMist(economy.outstanding)} />
      <MoneyMetric label="Reserved exposure" value={formatMist(economy.reservedExposure)} />
      <MoneyMetric label="Redeemed / paid" value={formatMist(economy.economy.redeemed_mist)} />
      <MoneyMetric label="Refunded" value={formatMist(economy.refund)} />
    </div> : <p className="mt-5 text-sm text-slate-500">No verified economic observation is available yet.</p>}
    <div className="mt-4 grid gap-3 rounded-2xl border border-slate-200 bg-white/70 p-4 text-xs sm:grid-cols-2 lg:grid-cols-4">
      <div><p className="font-semibold uppercase tracking-[0.1em] text-slate-500">Funding terms</p><p className="mt-1">Deposit: {formatMist(snapshot.config.deposit_mist)}</p><p>Input / output: {snapshot.config.price.input_rate} / {snapshot.config.price.output_rate} MIST per byte</p><p>Denominator: {snapshot.config.price.denominator}</p></div>
      <div><p className="font-semibold uppercase tracking-[0.1em] text-slate-500">Budget limits</p><p className="mt-1">Requests: {snapshot.config.budget.max_requests}</p><p>Total ceiling: {formatMist(snapshot.config.budget.max_total_mist)}</p><p>Turn ceiling: {formatMist(snapshot.config.budget.max_turn_mist)}</p></div>
      <div><p className="font-semibold uppercase tracking-[0.1em] text-slate-500">Chain evidence</p><p className="mt-1">Opening: {economy?.openingTransaction.state ?? 'unknown'} · {economy?.openingTransaction.digest ?? 'digest pending'}</p><p>Opening gas: {economy?.openingTransaction.gas ? formatMist(economy.openingTransaction.gas.computation_cost) : 'unknown'}</p><p>Locked funds: {formatMist(economy?.economy.locked_mist)}</p></div>
      <div><p className="font-semibold uppercase tracking-[0.1em] text-slate-500">Settlement</p><p className="mt-1">Waiting for credit: {snapshot.roles.coordinator.waiting_for_credit ? 'yes' : 'no'}</p><p>Terminal: {economy?.terminalTransaction?.digest ?? 'pending / unavailable'}</p><p>Terminal gas: {economy?.terminalTransaction?.gas ? formatMist(economy.terminalTransaction.gas.computation_cost) : 'unknown'}</p><p>Refund: {formatMist(economy?.refund)}</p></div>
    </div>
    {economy?.redeemedAboveDelivery && <p className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">Redeemed value exceeds delivered policy price; the UI preserves that discrepancy and will not hide it.</p>}
  </section>;
}

function MoneyMetric({ label, value, detail }: { label: string; value: string; detail?: string }) { return <div className="bg-white px-3 py-3"><dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</dt><dd className="mt-1 break-all font-mono text-xs font-semibold text-ink">{value}</dd>{detail && <p className="mt-1 text-[10px] text-slate-400">{detail}</p>}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-4 border-b border-slate-100 pb-2"><dt className="text-slate-500">{label}</dt><dd className="font-mono text-xs text-ink">{value}</dd></div>; }
function ConnectionPill({ label, value }: { label: string; value: string }) { return <span className="connection-pill"><i className={value === 'connected' ? 'live' : ''} />{label}: {value}</span>; }

function AgentPanel({ role, snapshot, state }: { role: MachineRole; snapshot: DemoSnapshot; state: ReturnType<typeof initialUiState> }) {
  const status = role === 'coordinator' ? snapshot.roles.coordinator : snapshot.roles.provider;
  const identity = role === 'coordinator' ? snapshot.identities.coordinator : snapshot.identities.provider;
  const entries = state.transcript.filter(entry => role === 'provider' ? entry.side === 'research' : entry.side === 'coordinator');
  return <article className={`panel ${role === 'coordinator' ? 'panel-coordinator' : 'panel-provider'}`}>
    <div className="flex items-start justify-between gap-4"><div><p className="eyebrow">{role === 'coordinator' ? 'Local agent' : 'Research agent'}</p><h2 className="panel-title">{identity.name}</h2><p className="mt-1 font-mono text-xs text-slate-500">{shortAddress(identity.agent.agent)} · {status?.runtime.model ?? 'runtime unavailable'}</p></div>{status && <ConnectionPill label="Iroh" value={status.connection.state} />}</div>
    <div className="mt-5 grid grid-cols-2 gap-2 text-xs"><div className="mini-stat"><span>Phase</span><strong>{status?.phase ?? 'unknown'}</strong></div><div className="mini-stat"><span>Task</span><strong>{status?.active_task ? shortAddress(status.active_task) : 'idle'}</strong></div><div className="mini-stat"><span>Request</span><strong>{status?.active_request ? shortAddress(status.active_request) : 'none'}</strong></div><div className="mini-stat"><span>Path</span><strong>{status?.connection.path ?? 'unknown'}</strong></div><div className="mini-stat"><span>Controller</span><strong>{shortAddress(identity.controller)}</strong></div><div className="mini-stat"><span>Authority</span><strong>{identity.alias_state} · gen {identity.generation}</strong></div><div className="mini-stat col-span-2"><span>Waiting for credit</span><strong>{status?.waiting_for_credit ? 'yes — no model continuation' : 'no'}</strong></div></div>
    <div className="transcript" aria-live="polite">{entries.length ? entries.map(entry => <div key={entry.id} className="message"><span className="message-kind">{entry.kind}</span><p>{entry.text}</p>{entry.citations.length > 0 && <ul className="mt-2 space-y-1">{entry.citations.map(citation => <li key={citation.url}><a className="source-link" href={citation.url} target="_blank" rel="noopener noreferrer">{citation.title}</a></li>)}</ul>}</div>) : <p className="empty-state">Waiting for durable public activity.</p>}</div>
  </article>;
}

export default App;
