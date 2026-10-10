import { useRef, useState, type FormEvent } from "react";
import type { ConnectCodeCheck, ConnectionStatus } from "../../shared/sail-models";
import type { Gateway } from "../gateway";
import { Logo } from "./icons";
import { Button } from "./ui";

/** What the first-run screen says once "Forget this box" has run: the Mac forgot, the box did not. */
export const FORGOTTEN_NOTICE =
  "Mast forgot the box on this Mac. The pairing still exists on the box until its owner runs sail fde unpair.";

type PairingGateway = Pick<Gateway, "previewConnectCode" | "pair">;

/**
 * The gate shown while the connection cannot carry the workspace. `unpaired` is the first run:
 * one field for the connect code, checked as it changes, and nothing else to set up. The passkey
 * door is the SSH-config fallback's (`unauthenticated`); anything else is a failure with its reason.
 */
export function ConnectScreen({
  status,
  gateway,
  onPaired,
  onLogin,
  busy,
  loginError,
  notice,
}: {
  status: ConnectionStatus;
  gateway: PairingGateway;
  onPaired: () => void;
  onLogin: () => void;
  busy: boolean;
  loginError: string | null;
  notice?: string | null;
}) {
  if (status.phase === "unpaired") {
    return (
      <div className="connect-screen" data-testid="connect-screen">
        <Logo size={40} />
        <h1 className="connect-title">Connect to your box</h1>
        {status.paired && status.host && (
          <p className="connect-detail" data-testid="connect-host">
            Paired with <code>{status.host}</code>
          </p>
        )}
        {status.detail && <p className="connect-error" data-testid="connect-reason">{status.detail}</p>}
        {notice && <p className="connect-detail" data-testid="connect-notice">{notice}</p>}
        <CodeForm gateway={gateway} onPaired={onPaired} />
      </div>
    );
  }
  const needsLogin = status.phase === "unauthenticated";
  return (
    <div className="connect-screen" data-testid="connect-screen">
      <Logo size={40} />
      <h1 className="connect-title">{needsLogin ? "Sign in to Sail" : "Can’t reach the control plane"}</h1>
      {!needsLogin && (
        <p className="connect-detail">{status.detail ?? `Nothing answered at ${status.server}.`}</p>
      )}
      {needsLogin ? (
        <Button onClick={onLogin} disabled={busy} data-testid="connect-login">
          {busy ? "Waiting for Touch ID…" : "Sign in with passkey"}
        </Button>
      ) : (
        !status.paired && (
          <p className="connect-detail">
            Check <code>host:</code> and <code>server:</code> in <code>~/.sail/config.yaml</code>.
          </p>
        )
      )}
      {loginError && <p className="connect-error">{loginError}</p>}
    </div>
  );
}

function CodeForm({ gateway, onPaired }: { gateway: PairingGateway; onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [check, setCheck] = useState<ConnectCodeCheck | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useRef(0);

  const change = (next: string) => {
    setCode(next);
    setFailure(null);
    const turn = ++latest.current;
    if (!next.trim()) return void setCheck(null);
    void gateway.previewConnectCode(next).then((result) => {
      if (latest.current === turn) setCheck(result);
    });
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (connecting || !check?.ok) return;
    setConnecting(true);
    setFailure(null);
    const result = await gateway.pair(code);
    setConnecting(false);
    if (result.ok) onPaired();
    else setFailure(result.detail ?? "Mast could not connect with this code.");
  };

  return (
    <form className="connect-form" onSubmit={(event) => void connect(event)}>
      <input
        className="input connect-code"
        type="password"
        aria-label="Connect code"
        placeholder="Paste your connect code"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={code}
        disabled={connecting}
        onChange={(event) => change(event.target.value)}
        data-testid="connect-code"
      />
      {failure ? (
        <p className="connect-error" data-testid="connect-code-error">{failure}</p>
      ) : check?.ok ? (
        <p className="connect-detail" data-testid="connect-code-preview">
          {check.value.email || check.value.handle} on <code>{check.value.host}</code>
        </p>
      ) : (
        check && <p className="connect-error" data-testid="connect-code-error">{check.detail}</p>
      )}
      <Button type="submit" disabled={connecting || !check?.ok} data-testid="connect-pair">
        {connecting ? "Connecting…" : "Connect"}
      </Button>
    </form>
  );
}
