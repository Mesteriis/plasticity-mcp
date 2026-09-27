import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4318,
    proxy: {
      "/api": "http://127.0.0.1:4317",
    },
  },
  worker: {
    format: "es",
  },
  test: {
    include: ["test/web/**/*.test.{ts,tsx}"],
  },
});
