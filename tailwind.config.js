/**
 * Dark-first token mapping. Semantic color utilities (bg-bg, text-content, …)
 * resolve to CSS variables defined in src/mainview/styles.css. The
 * `mast-design-system` spec fills in the full token set here.
 * @type {import('tailwindcss').Config}
 */
export default {
  darkMode: "class",
  content: ["./src/mainview/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--color-bg)",
        surface: "var(--color-surface)",
        border: "var(--color-border)",
        content: "var(--color-content)",
        muted: "var(--color-muted)",
        accent: "var(--color-accent)",
      },
    },
  },
  plugins: [],
};
