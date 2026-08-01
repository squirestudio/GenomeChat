import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  server: {
    fs: {
      // /privacy and /terms render `legal/*.md` directly, so the published
      // pages cannot drift from the drafts that get reviewed. Those files live
      // one level above `frontend/`, and the dev server refuses to read outside
      // its root unless told otherwise. The production build resolves them at
      // bundle time and is unaffected — which is the trap: removing this breaks
      // `npm run dev` while `npm run build` keeps working.
      allow: ['..'],
    },
  },
})
