import { defineConfig } from "vite";

export default defineConfig({
	server: {
		host: true,
		port: 5173,
		strictPort: true,
		// Vite rejects requests whose Host header it does not recognize; allow
		// the devbox.so preview URLs (the leading dot matches any subdomain).
		allowedHosts: [".devbox.so"],
		// Behind the devbox.so HTTPS proxy, the browser reaches the dev
		// server on 443, so point hot reload there instead of 5173.
		hmr: process.env.ARENA_PREVIEW ? { protocol: "wss", clientPort: 443 } : undefined,
	},
});
