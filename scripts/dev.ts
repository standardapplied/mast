/**
 * Dev loop: run the vite dev server (React webview + HMR on :5173) alongside
 * `electrobun dev --watch` (rebuilds and reruns the Bun main). The Bun main loads
 * http://localhost:5173 when MAST_DEV is set (see window-manager). Ctrl-C tears
 * both down together.
 */
const env = { ...process.env, MAST_DEV: "1" };

const vite = Bun.spawn(["bunx", "vite", "--port", "5173"], { env, stdio: ["inherit", "inherit", "inherit"] });
const electrobun = Bun.spawn(["bunx", "electrobun", "dev", "--watch"], {
  env,
  stdio: ["inherit", "inherit", "inherit"],
});

const shutdown = () => {
  vite.kill();
  electrobun.kill();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.race([vite.exited, electrobun.exited]);
shutdown();

export {};
