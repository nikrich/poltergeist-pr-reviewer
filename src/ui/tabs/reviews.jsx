// Queue + approval + history. Pull state on mount, re-pull on pushed
// state:changed events (ipc.send is never queued by the host).

import { useEffect, useRef, useState } from 'react';
import { Panel, ErrorBanner, Btn, Pill, inputStyle } from '../kit.jsx';

const ORDER = ['awaiting_approval', 'reviewing', 'detected', 'failed', 'submitted', 'skipped', 'dismissed'];
const HIDDEN_STATES = ['dismissed', 'skipped'];
const LABEL = {
  awaiting_approval: 'awaiting approval',
  reviewing: 'reviewing',
  detected: 'queued',
  failed: 'failed',
  submitted: 'submitted',
  skipped: 'skipped',
  dismissed: 'dismissed',
};
const TONE = {
  awaiting_approval: 'neon',
  reviewing: 'fog',
  detected: 'fog',
  failed: 'oxblood',
  submitted: 'moss',
  skipped: 'outline',
  dismissed: 'outline',
};
const SEV_TONE = { blocker: 'oxblood', issue: 'neon', nit: 'fog' };

function areaStyle(s) {
  return { ...inputStyle(s), width: '100%', minHeight: 60, resize: 'vertical', fontFamily: 'inherit' };
}

function Finding({ s, f, onEdit, onDelete, disabled }) {
  const [body, setBody] = useState(f.body);
  return (
    <div style={{ border: `1px solid ${s.hairline}`, borderRadius: 6, padding: 8, marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <Pill s={s} tone={SEV_TONE[f.severity] ?? 'fog'}>{f.severity}</Pill>
        <code style={{ color: s.ink1, fontSize: 12 }}>{f.path}:{f.line}</code>
        <span style={{ flex: 1 }} />
        <Btn s={s} danger disabled={disabled} onClick={onDelete}>delete</Btn>
      </div>
      <textarea
        style={areaStyle(s)}
        value={body}
        disabled={disabled}
        onChange={(e) => setBody(e.target.value)}
        onBlur={() => body !== f.body && onEdit(body)}
      />
    </div>
  );
}

function PrCard({ api, s, pr, refresh, setError }) {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(pr.draft?.summary ?? '');
  const lastDraftSummary = useRef(pr.draft?.summary ?? '');
  useEffect(() => {
    const ds = pr.draft?.summary ?? '';
    if (ds !== lastDraftSummary.current) {
      lastDraftSummary.current = ds;
      setSummary(ds);
    }
  }, [pr.draft?.summary]);

  const act = async (channel, payload = {}) => {
    setBusy(true);
    setError('');
    try {
      await api.ipc.invoke(channel, { key: pr.key, ...payload });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: `1px solid ${s.hairline}`, borderRadius: 8, padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Pill s={s} tone={TONE[pr.state]}>{LABEL[pr.state]}</Pill>
        <a
          href="#"
          style={{ color: s.ink0, fontWeight: 600, textDecoration: 'none' }}
          onClick={(e) => {
            e.preventDefault();
            api.openExternal(pr.url);
          }}
        >
          {pr.key}
        </a>
        <span style={{ color: s.ink2 }}>{pr.title}</span>
        <span style={{ flex: 1 }} />
        {pr.account && <span style={{ color: s.ink2, fontSize: 12 }}>as {pr.account}</span>}
      </div>
      <div style={{ color: s.ink2, fontSize: 12, marginTop: 4 }}>from {pr.sources.join(', ')}</div>

      {pr.error && <div style={{ color: s.oxblood, marginTop: 6, whiteSpace: 'pre-wrap', fontSize: 12 }}>{pr.error}</div>}

      {pr.state === 'awaiting_approval' && pr.draft && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: s.ink2, fontSize: 12, marginBottom: 4 }}>summary</div>
          <textarea
            style={areaStyle(s)}
            value={summary}
            disabled={busy}
            onChange={(e) => setSummary(e.target.value)}
            onBlur={() => summary !== pr.draft.summary && act('summary:update', { summary })}
          />
          {pr.draft.findings.map((f, i) => (
            <Finding
              key={`${f.path}:${f.line}:${i}`}
              s={s}
              f={f}
              disabled={busy}
              onEdit={(body) => act('finding:update', { index: i, body })}
              onDelete={() => act('finding:delete', { index: i })}
            />
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Btn s={s} primary disabled={busy} onClick={() => act('review:submit')}>
              submit review
            </Btn>
            <Btn s={s} disabled={busy} onClick={() => act('review:dismiss')}>dismiss</Btn>
          </div>
        </div>
      )}

      {pr.state === 'failed' && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Btn s={s} primary disabled={busy} onClick={() => act('review:retry')}>retry</Btn>
          <Btn s={s} disabled={busy} onClick={() => act('review:dismiss')}>dismiss</Btn>
        </div>
      )}

      {pr.state === 'submitted' && pr.reviewUrl && (
        <div style={{ marginTop: 6 }}>
          <a
            href="#"
            style={{ color: s.moss, fontSize: 12 }}
            onClick={(e) => {
              e.preventDefault();
              api.openExternal(pr.reviewUrl);
            }}
          >
            view submitted review →
          </a>
        </div>
      )}
    </div>
  );
}

export function ReviewsTab({ api, s }) {
  const [store, setStore] = useState(null);
  const [env, setEnv] = useState(null);
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState(null); // {newPrs, scanned}
  const [showHistory, setShowHistory] = useState(false);

  const refresh = () => api.ipc.invoke('state:get').then(setStore).catch((e) => setError(e.message));

  const checkNow = async () => {
    setScanning(true);
    setScanResult(null);
    setError('');
    try {
      const res = await api.ipc.invoke('sweep:now');
      setScanResult(res);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    refresh();
    api.ipc.invoke('env:check').then(setEnv).catch(() => {});
    const off = api.ipc.on('state:changed', refresh);
    return off;
  }, []);

  if (!store) return <div style={{ color: s.ink2 }}>loading…</div>;

  const all = Object.values(store.prs).sort(
    (a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || (a.timestamps.detected < b.timestamps.detected ? 1 : -1)
  );
  // dismissed/skipped are closed history — keep them out of the working view
  const hiddenCount = all.filter((p) => HIDDEN_STATES.includes(p.state)).length;
  const prs = showHistory ? all : all.filter((p) => !HIDDEN_STATES.includes(p.state));
  const queued = all.filter((p) => p.state === 'detected').length;

  const dismissAll = () => {
    // dismissed is terminal and dedupe keeps these PRs out for good — arm first
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 4000);
      return;
    }
    setConfirmClear(false);
    api.ipc.invoke('queue:dismiss-all').then(refresh).catch((e) => setError(e.message));
  };

  const envProblem =
    env && (!env.claude || !env.gh || env.accounts === 0)
      ? [
          !env.gh && 'gh CLI not found — install GitHub CLI',
          env.gh && env.accounts === 0 && 'no gh accounts — run `gh auth login`',
          !env.claude && 'claude CLI not found — install Claude Code or set its path in settings',
        ]
          .filter(Boolean)
          .join(' · ')
      : '';

  return (
    <div>
      <ErrorBanner error={error} s={s} />
      {envProblem && <div style={{ color: s.oxblood, marginBottom: 10, fontSize: 12 }}>{envProblem}</div>}
      <Panel
        title={`pull requests (${prs.length})`}
        s={s}
        action={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {scanResult && !scanning && (
              <span style={{ color: s.ink2, fontSize: 12 }}>
                {scanResult.newPrs > 0
                  ? `found ${scanResult.newPrs} new PR${scanResult.newPrs === 1 ? '' : 's'}`
                  : scanResult.scanned > 0
                    ? `checked ${scanResult.scanned} changed note${scanResult.scanned === 1 ? '' : 's'} · nothing new`
                    : 'no notes changed since last check'}
              </span>
            )}
            {queued > 0 && (
              <Btn s={s} danger onClick={dismissAll}>
                {confirmClear ? `really dismiss ${queued}?` : `dismiss queued (${queued})`}
              </Btn>
            )}
            <Btn s={s} disabled={scanning} onClick={checkNow}>
              {scanning ? 'checking…' : 'check for new PRs'}
            </Btn>
          </div>
        }
      >
        {prs.length === 0 && hiddenCount === 0 && (
          <div style={{ color: s.ink2 }}>
            No PRs tracked yet. Every few minutes this plugin looks through recently edited notes in your vault for
            GitHub pull-request links and queues them for review — “check for new PRs” runs one pass right now.
          </div>
        )}
        {prs.length === 0 && hiddenCount > 0 && (
          <div style={{ color: s.ink2 }}>
            Nothing needs your attention. New PR links found in recently edited notes will show up here.
          </div>
        )}
        {prs.map((pr) => (
          <PrCard key={pr.key} api={api} s={s} pr={pr} refresh={refresh} setError={setError} />
        ))}
        {hiddenCount > 0 && (
          <button
            style={{ background: 'none', border: 'none', color: s.ink2, fontSize: 12, cursor: 'pointer', padding: '8px 0 0' }}
            onClick={() => setShowHistory(!showHistory)}
          >
            {showHistory ? 'hide dismissed & skipped' : `show ${hiddenCount} dismissed & skipped`}
          </button>
        )}
      </Panel>
    </div>
  );
}
