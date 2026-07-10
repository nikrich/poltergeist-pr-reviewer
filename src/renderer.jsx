// PR Reviewer renderer shell: theme, tabs, mount. Tab bodies live in
// src/ui/tabs/*.jsx; styling primitives in src/ui/kit.jsx (from freelancer).

import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { S, setTheme, btnStyle } from './ui/kit.jsx';
import { ReviewsTab } from './ui/tabs/reviews.jsx';
import { SettingsTab } from './ui/tabs/settings.jsx';

const TABS = [
  { id: 'reviews', label: 'reviews', Component: ReviewsTab },
  { id: 'settings', label: 'settings', Component: SettingsTab },
];

function App({ api }) {
  const s = S();
  const [tab, setTab] = useState('reviews');
  const Active = TABS.find((t) => t.id === tab)?.Component ?? ReviewsTab;

  return (
    <div style={{ padding: 18, color: s.ink0, fontSize: 13, fontFamily: 'inherit' }}>
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${s.hairline}`, marginBottom: 14 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            style={{
              ...btnStyle(s, false),
              border: 'none',
              borderBottom: tab === t.id ? `2px solid ${s.neon}` : '2px solid transparent',
              borderRadius: 0,
              color: tab === t.id ? s.ink0 : s.ink2,
              fontWeight: tab === t.id ? 600 : 400,
            }}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Active api={api} s={s} />
    </div>
  );
}

export function mount(el, api) {
  setTheme(api.theme ?? {});
  const root = createRoot(el);
  root.render(<App api={api} />);
  return () => root.unmount();
}
