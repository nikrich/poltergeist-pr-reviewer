import { build } from 'esbuild';

// Renderer: React bundled in, ESM for the app's dynamic import via plugin://
await build({
  entryPoints: ['src/renderer.jsx'],
  outfile: 'dist/renderer.mjs',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

// Main: CommonJS for require() in the Electron main process.
// electron is provided by the host app at runtime — never bundle it.
await build({
  entryPoints: ['src/main.cjs'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  minify: true,
  logLevel: 'info',
});
