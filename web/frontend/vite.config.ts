import { defineConfig } from "vite";

export default defineConfig({
    build: {
        outDir: "dist",
        emptyOutDir: true,
    },
    server: {
        // Dev server proxies API calls to the backend so you can run `npm run dev`
        // on the host for fast iteration without docker.
        proxy: {
            "/files": "http://localhost:8090",
            "/chat": "http://localhost:8090",
            "/health": "http://localhost:8090",
        },
    },
});
