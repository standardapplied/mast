/**
 * The React app owns the decision of whether it's safe to quit (unsaved work,
 * in-flight transfers, …). The Bun main asks the webview via the `confirmQuit`
 * request on programmatic quits, which consults this gate. The shell defaults
 * to allowing quit; feature specs with real unsaved state register a gate.
 */
type QuitGate = () => boolean | Promise<boolean>;

let gate: QuitGate = () => true;

export function setQuitGate(fn: QuitGate): void {
  gate = fn;
}

export function resetQuitGate(): void {
  gate = () => true;
}

export async function shouldAllowQuit(): Promise<boolean> {
  return gate();
}
