import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static dashboard build for Cloudflare Pages.
// - Output goes to dist/ (Cloudflare Pages "Build output directory").
// - This build ONLY bundles the React dashboard reachable from index.html.
//   The Playwright scraper (src/capture-rexel.js, src/selectors.js) is never
//   imported here, so it is never bundled or executed during the Pages build.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
