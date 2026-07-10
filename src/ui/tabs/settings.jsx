// Config editor persisted via api.settings under the same 'config' key main
// reads. Poll-interval changes take effect on the next loop tick.

import { useEffect, useState } from 'react';
import { Panel, Btn, Field, ErrorBanner } from '../kit.jsx';

const DEFAULT_CONFIG = {
  vaultPath: '~/ghostbrain/vault',
  folders: ['00-inbox', '20-contexts'],
  pollMinutes: 3,
  engine: { prompt: '', thoroughness: 'standard', skill: '' },
  claudeBin: 'claude',
  timeoutMinutes: 15,
};

export function SettingsTab({ api, s }) {
  const [config, setConfig] = useState(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.settings
      .get('config')
      .then((c) => setConfig({ ...DEFAULT_CONFIG, ...(c ?? {}), engine: { ...DEFAULT_CONFIG.engine, ...(c?.engine ?? {}) } }))
      .catch(() => setConfig(DEFAULT_CONFIG));
  }, [api]);

  if (!config) return null;

  const set = (patch) => {
    setConfig({ ...config, ...patch });
    setSaved(false);
  };
  const setEngine = (patch) => set({ engine: { ...config.engine, ...patch } });

  const save = async () => {
    setError('');
    try {
      await api.settings.set('config', config);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <ErrorBanner error={error} s={s} />
      <Panel title="vault" s={s}>
        <Field s={s} label="vault path" value={config.vaultPath} onChange={(v) => set({ vaultPath: v })} />
        <Field
          s={s}
          label="watched folders (comma-separated)"
          value={config.folders.join(', ')}
          onChange={(v) => set({ folders: v.split(',').map((x) => x.trim()).filter(Boolean) })}
        />
        <Field
          s={s}
          label="poll interval (minutes)"
          type="number"
          value={String(config.pollMinutes)}
          onChange={(v) => set({ pollMinutes: Math.max(1, Number(v) || 3) })}
        />
      </Panel>

      <Panel title="review engine" s={s}>
        <Field
          s={s}
          label="skill (optional — overrides prompt, e.g. code-review)"
          value={config.engine.skill}
          onChange={(v) => setEngine({ skill: v })}
        />
        <Field s={s} label="review prompt (used when no skill is set)" value={config.engine.prompt} onChange={(v) => setEngine({ prompt: v })} />
        <div style={{ margin: '8px 0' }}>
          <div style={{ color: s.ink2, fontSize: 12, marginBottom: 4 }}>thoroughness</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {['quick', 'standard', 'thorough'].map((t) => (
              <Btn key={t} s={s} primary={config.engine.thoroughness === t} onClick={() => setEngine({ thoroughness: t })}>
                {t}
              </Btn>
            ))}
          </div>
        </div>
        <Field s={s} label="claude binary" value={config.claudeBin} onChange={(v) => set({ claudeBin: v })} />
        <Field
          s={s}
          label="review timeout (minutes)"
          type="number"
          value={String(config.timeoutMinutes)}
          onChange={(v) => set({ timeoutMinutes: Math.max(1, Number(v) || 15) })}
        />
      </Panel>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Btn s={s} primary onClick={save}>save</Btn>
        {saved && <span style={{ color: s.moss, fontSize: 12 }}>saved</span>}
      </div>
    </div>
  );
}
