/** @type {import('tailwindcss').Config} */
// Utilities only, prefixed `tw-`: the existing hand-written stylesheet keeps priority and nothing is reset
// (no preflight). Use e.g. `tw-absolute tw-z-20` for positioning helpers in new components.
export default {
  prefix: "tw-",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
