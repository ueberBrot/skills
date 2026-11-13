import { defineConfig } from "vite-plus";

export default defineConfig({ fmt: {}, lint: { env: { browser: false, node: true } } });
