import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            /node_modules\/(react|react-dom|scheduler)\//.test(
              id.replaceAll("\\", "/"),
            )
          )
            return "react-vendor";
        },
      },
    },
  },
});
