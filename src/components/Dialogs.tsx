import { CircleCheck, KeyRound, Lock, ShieldAlert, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { ImportReport } from "../api";
import { Dialog } from "./Dialog";

export function InputDialog(props: {
  title: string;
  label: string;
  initial: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(props.initial);
  const valid = value.trim().length > 0 && !value.includes("/");
  return (
    <Dialog
      title={props.title}
      onClose={props.onCancel}
      onSubmit={() => valid && props.onConfirm(value.trim())}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!valid}>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{props.label}</span>
        <input value={value} spellCheck={false} onChange={(e) => setValue(e.target.value)} />
      </label>
    </Dialog>
  );
}

export function ConfirmDialog(props: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      title={props.title}
      icon={props.danger ? <TriangleAlert size={18} /> : undefined}
      onClose={props.onCancel}
      onSubmit={props.onConfirm}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className={`button ${props.danger ? "danger" : "primary"}`} data-autofocus>
            {props.confirmLabel}
          </button>
        </>
      }
    >
      <div className="dialog-message">{props.message}</div>
    </Dialog>
  );
}

export function SecretDialog(props: {
  kind: "password" | "passphrase";
  siteLabel: string;
  message?: string;
  canRemember: boolean;
  onCancel: () => void;
  onSubmit: (value: string, remember: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(true);
  const isPassword = props.kind === "password";
  return (
    <Dialog
      title={isPassword ? `Password for ${props.siteLabel}` : `Key passphrase for ${props.siteLabel}`}
      icon={isPassword ? <Lock size={18} /> : <KeyRound size={18} />}
      onClose={props.onCancel}
      onSubmit={() => props.onSubmit(value, remember && props.canRemember)}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Connect
          </button>
        </>
      }
    >
      {props.message && <p className="dialog-message">{props.message}</p>}
      <label className="field">
        <span>{isPassword ? "Password" : "Passphrase"}</span>
        <input type="password" value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      {props.canRemember && (
        <label className="checkbox">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>Save in Keychain</span>
        </label>
      )}
    </Dialog>
  );
}

export function HostKeyDialog(props: {
  hostPort: string;
  expected: string;
  actual: string;
  onCancel: () => void;
  onTrust: () => void;
}) {
  return (
    <Dialog
      title="Host key changed"
      icon={<ShieldAlert size={18} />}
      width={520}
      onClose={props.onCancel}
      onSubmit={props.onCancel}
      footer={
        <>
          <button type="button" className="button danger-ghost" onClick={props.onTrust}>
            Trust the new key
          </button>
          <span className="spacer" />
          <button type="submit" className="button primary" data-autofocus>
            Cancel
          </button>
        </>
      }
    >
      <p className="dialog-message">
        The server at <strong>{props.hostPort}</strong> sent a different host key than the one saved earlier. This happens when a
        server is reinstalled or moved. It can also mean the connection is being intercepted.
      </p>
      <div className="fingerprints">
        <div>
          <span>Saved</span>
          <code>{props.expected}</code>
        </div>
        <div>
          <span>Received</span>
          <code>{props.actual}</code>
        </div>
      </div>
    </Dialog>
  );
}

const PERMISSION_LABELS = ["Owner", "Group", "Others"];
const BIT_LABELS = ["Read", "Write", "Execute"];

export function ChmodDialog(props: {
  names: string[];
  initial: number;
  onCancel: () => void;
  onConfirm: (mode: number) => void;
}) {
  const [mode, setMode] = useState(props.initial & 0o777);
  const [text, setText] = useState((props.initial & 0o777).toString(8).padStart(3, "0"));
  const update = (next: number) => {
    setMode(next);
    setText(next.toString(8).padStart(3, "0"));
  };
  const title = props.names.length === 1 ? `Permissions for ${props.names[0]}` : `Permissions for ${props.names.length} items`;
  return (
    <Dialog
      title={title}
      onClose={props.onCancel}
      onSubmit={() => props.onConfirm(mode)}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Apply
          </button>
        </>
      }
    >
      <table className="perm-table">
        <thead>
          <tr>
            <th />
            {BIT_LABELS.map((b) => (
              <th key={b}>{b}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PERMISSION_LABELS.map((who, row) => (
            <tr key={who}>
              <td>{who}</td>
              {[4, 2, 1].map((bit) => {
                const mask = bit << ((2 - row) * 3);
                return (
                  <td key={bit}>
                    <input type="checkbox" checked={(mode & mask) !== 0} onChange={(e) => update(e.target.checked ? mode | mask : mode & ~mask)} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <label className="field narrow">
        <span>Numeric value</span>
        <input
          value={text}
          maxLength={3}
          onChange={(e) => {
            setText(e.target.value);
            if (/^[0-7]{3}$/.test(e.target.value)) setMode(parseInt(e.target.value, 8));
          }}
        />
      </label>
    </Dialog>
  );
}

export function ImportReportDialog({ report, onClose }: { report: ImportReport; onClose: () => void }) {
  return (
    <Dialog
      title={`Imported from ${report.source}`}
      icon={<CircleCheck size={18} />}
      width={480}
      onClose={onClose}
      onSubmit={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="submit" className="button primary" data-autofocus>
            Done
          </button>
        </>
      }
    >
      <ul className="import-summary">
        <li>
          <strong>{report.imported}</strong> {report.imported === 1 ? "site" : "sites"} added
        </li>
        {report.alreadyPresent > 0 && (
          <li>
            <strong>{report.alreadyPresent}</strong> already in Dispatch, skipped
          </li>
        )}
        {report.unsupported.length > 0 && (
          <li>
            <strong>{report.unsupported.length}</strong> use a protocol Dispatch does not support yet: {report.unsupported.join(", ")}
          </li>
        )}
      </ul>
      {report.needPassword.length > 0 && report.source === "FileZilla" && (
        <p className="dialog-message">
          {report.needPassword.length === 1 ? "One site has" : `${report.needPassword.length} sites have`} a password protected by
          FileZilla's master password, which Dispatch cannot read. Dispatch asks for the password on the first connect and can save it
          in the Keychain: {report.needPassword.join(", ")}.
        </p>
      )}
      {report.needPassword.length > 0 && report.source === "Cyberduck" && (
        <p className="dialog-message">
          Cyberduck keeps passwords in the Keychain, not in its bookmarks, so they were not imported. Dispatch asks for the password on
          the first connect and can save it in the Keychain: {report.needPassword.join(", ")}.
        </p>
      )}
      <p className="dialog-note">Source: {report.path}</p>
    </Dialog>
  );
}
