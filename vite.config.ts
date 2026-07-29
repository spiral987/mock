import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // ag-psd はブラウザに無い Node `util` を一部経路で require する。最小シムに差し替える。
      util: fileURLToPath(new URL('./src/util/nodeUtilShim.ts', import.meta.url)),
    },
  },
});
