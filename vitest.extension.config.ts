import { defineConfig } from "vitest/config";

// The extension's own tests (host/); the compiler's suite stays in vitest.config.ts. They run against the emit in
// dist/ (`npm run build` first): the worker thread loads emitted JavaScript.
export default defineConfig({
    test: {
        include: ["host/**/*.test.ts"],
        environment: "node",
        testTimeout: 120000,
    },
});
