// Component kit: theme access + shared styled primitives used across tabs.
// The host mounts the renderer via mount(el, api) in renderer.jsx, which calls
// setTheme(api.theme) once at mount time; everything here reads theme via S().

/* ---------- tiny styling system on the host theme ---------- */
let T = {};
export function setTheme(theme) {
  T = theme ?? {};
}
const t = (k, fb) => T[k] || fb;
export const S = () => ({
  ink0: t('--ink-0', '#F2F3F5'),
  ink1: t('--ink-1', '#B7BAC2'),
  ink2: t('--ink-2', '#7A7E88'),
  paper: t('--paper', '#0E0F12'),
  vellum: t('--vellum', '#15171B'),
  fog: t('--fog', '#1E2026'),
  hairline: t('--hairline', 'rgba(242,243,245,0.08)'),
  hairline2: t('--hairline-2', 'rgba(242,243,245,0.14)'),
  neon: t('--neon', '#C5FF3D'),
  oxblood: t('--oxblood', '#FF6B5A'),
  moss: t('--moss', '#5C7C4F'),
});

export const inputStyle = (s) => ({
  background: s.paper,
  border: `1px solid ${s.hairline2}`,
  borderRadius: 6,
  color: s.ink0,
  fontSize: 12,
  padding: '6px 8px',
  outline: 'none',
  width: '100%',
});

export const btnStyle = (s, primary) => ({
  background: primary ? s.neon : 'transparent',
  color: primary ? s.paper : s.ink1,
  border: primary ? 'none' : `1px solid ${s.hairline2}`,
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: primary ? 600 : 400,
  cursor: 'pointer',
});

export function Panel({ title, s, action, children }) {
  return (
    <div style={{ background: s.vellum, border: `1px solid ${s.hairline}`, borderRadius: 10, padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.12em', color: s.ink2 }}>{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

export function ErrorBanner({ error, s }) {
  if (!error) return null;
  return <div style={{ color: s.oxblood, fontSize: 12, margin: '8px 0' }}>{error}</div>;
}

/* ---------- buttons + inputs ---------- */

export function Btn({ s, primary, danger, children, onClick, disabled, style, ...rest }) {
  const base = btnStyle(s, primary);
  const dangerStyle = danger
    ? {
        color: primary ? s.paper : s.oxblood,
        background: primary ? s.oxblood : 'transparent',
        border: primary ? 'none' : `1px solid ${s.oxblood}`,
      }
    : null;
  return (
    <button style={{ ...base, ...dangerStyle, ...style }} onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}

export function Input({ s, style, ...rest }) {
  return <input style={{ ...inputStyle(s), ...style }} {...rest} />;
}

/* ---------- badges + tiles ---------- */

export function Pill({ s, tone = 'fog', children }) {
  const colors = {
    neon: { bg: 'rgba(197,255,61,0.12)', fg: s.neon },
    moss: { bg: 'rgba(92,124,79,0.25)', fg: '#9FBF8F' },
    oxblood: { bg: 'rgba(255,107,90,0.12)', fg: s.oxblood },
    fog: { bg: s.fog, fg: s.ink1 },
    outline: { bg: 'transparent', fg: s.ink2 },
  }[tone] ?? { bg: s.fog, fg: s.ink1 };
  return (
    <span style={{ background: colors.bg, color: colors.fg, border: tone === 'outline' ? `1px solid ${s.hairline2}` : 'none',
      borderRadius: 999, padding: '2px 8px', fontSize: 10, fontFamily: 'ui-monospace, monospace', textTransform: 'lowercase', whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

const STATUS_TONE = { draft: 'fog', sent: 'neon', accepted: 'moss', paid: 'moss', declined: 'oxblood', overdue: 'oxblood', invoiced: 'outline' };
export function StatusPill({ s, status }) {
  return <Pill s={s} tone={STATUS_TONE[status] ?? 'fog'}>{status}</Pill>;
}

export function StatTile({ s, label, value, sub, accent, subTone }) {
  return (
    <div style={{ background: s.vellum, border: `1px solid ${s.hairline}`, borderRadius: 10, padding: '12px 14px', flex: 1, minWidth: 0 }}>
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 10, textTransform: 'lowercase', letterSpacing: '0.1em', color: s.ink2 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent ? s.neon : s.ink0, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: subTone ?? s.ink2, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function Field({ s, label, value, onChange, type = 'text', ...rest }) {
  return (
    <label style={{ fontSize: 11, color: s.ink2, display: 'block', marginBottom: 8 }}>
      {label}
      <input style={inputStyle(s)} type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest} />
    </label>
  );
}
