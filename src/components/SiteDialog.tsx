import { open } from "@tauri-apps/plugin-dialog";
import { Server, Trash2 } from "./icons";
import { useState } from "react";
import { PROTOCOLS, type AuthMethod, type Protocol, type Site } from "../api";
import { Dialog } from "./Dialog";
import { SITE_COLORS } from "./Sidebar";

interface SiteDialogProps {
  site: Site;
  folders: string[];
  home: string;
  onCancel: () => void;
  onSave: (site: Site, secrets: { password?: string; passphrase?: string }, connect: boolean) => void;
  onConnectOnly: (site: Site, password?: string) => void;
  onDelete?: () => void;
}

const AUTH_OPTIONS: { value: AuthMethod; label: string; sftpOnly?: boolean }[] = [
  { value: "password", label: "Password" },
  { value: "ask", label: "Ask for password" },
  { value: "key", label: "Key file", sftpOnly: true },
  { value: "agent", label: "SSH agent", sftpOnly: true },
  { value: "anonymous", label: "Anonymous" },
];

export function SiteDialog({ site: initial, folders, home, onCancel, onSave, onConnectOnly, onDelete }: SiteDialogProps) {
  const [site, setSite] = useState<Site>(initial);
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [passphrase, setPassphrase] = useState<string | undefined>(undefined);
  const isNew = !initial.id;
  const isSftp = site.protocol === "sftp";
  const set = <K extends keyof Site>(key: K, value: Site[K]) => setSite((s) => ({ ...s, [key]: value }));

  const setProtocol = (protocol: Protocol) => {
    setSite((s) => {
      const oldDefault = PROTOCOLS.find((p) => p.value === s.protocol)?.port;
      const newDefault = PROTOCOLS.find((p) => p.value === protocol)?.port ?? 21;
      const auth = protocol !== "sftp" && (s.auth === "key" || s.auth === "agent") ? "password" : s.auth;
      return { ...s, protocol, auth, port: !s.port || s.port === oldDefault ? newDefault : s.port };
    });
  };

  const pickKey = async () => {
    const file = await open({ multiple: false, directory: false, defaultPath: site.keyPath || `${home}/.ssh` });
    if (typeof file === "string") set("keyPath", file);
  };

  const pickLocalDir = async () => {
    const dir = await open({ multiple: false, directory: true, defaultPath: site.localDir || undefined });
    if (typeof dir === "string") set("localDir", dir);
  };

  const valid = site.host.trim().length > 0;
  const secrets = { password, passphrase };

  return (
    <Dialog
      title={isNew ? "New site" : `Edit ${initial.name || initial.host}`}
      icon={<Server size={18} />}
      width={560}
      onClose={onCancel}
      onSubmit={() => valid && onSave(site, secrets, true)}
      footer={
        <>
          {onDelete && (
            <button type="button" className="button danger-ghost" onClick={onDelete}>
              <Trash2 size={14} /> Delete
            </button>
          )}
          {isNew && (
            <button type="button" className="button ghost" disabled={!valid} onClick={() => onConnectOnly(site, password)}>
              Connect without saving
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="button" disabled={!valid} onClick={() => onSave(site, secrets, false)}>
            Save
          </button>
          <button type="submit" className="button primary" disabled={!valid}>
            Save and connect
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label className="field span-2">
          <span>Name</span>
          <input value={site.name} placeholder={site.host || "My server"} onChange={(e) => set("name", e.target.value)} data-autofocus />
        </label>

        <div className="field span-2">
          <span>Protocol</span>
          <div className="segmented">
            {PROTOCOLS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={site.protocol === p.value ? "active" : ""}
                onClick={() => setProtocol(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <small className="hint">
            {site.protocol === "ftp" && "Uses TLS when the server supports it, otherwise plain FTP."}
            {site.protocol === "ftpes" && "Requires TLS (explicit, port 21)."}
            {site.protocol === "ftps" && "Implicit TLS, usually port 990."}
            {site.protocol === "ftp-plain" && "No encryption. Passwords are sent in clear text."}
            {site.protocol === "sftp" && "File transfer over SSH."}
          </small>
        </div>

        <label className="field wide">
          <span>Host</span>
          <input
            value={site.host}
            placeholder="example.com"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => set("host", e.target.value)}
          />
        </label>
        <label className="field narrow">
          <span>Port</span>
          <input
            type="number"
            value={site.port || ""}
            onChange={(e) => set("port", Number(e.target.value) || 0)}
          />
        </label>

        <label className="field">
          <span>Username</span>
          <input
            value={site.user}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={site.auth === "anonymous"}
            onChange={(e) => set("user", e.target.value)}
          />
        </label>
        <label className="field">
          <span>Authentication</span>
          <select value={site.auth} onChange={(e) => set("auth", e.target.value as AuthMethod)}>
            {AUTH_OPTIONS.filter((o) => isSftp || !o.sftpOnly).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {site.auth === "password" && (
          <label className="field span-2">
            <span>Password</span>
            <div className="input-with-action">
              <input
                type="password"
                value={password ?? ""}
                placeholder={site.passwordSaved && password === undefined ? "Saved in Keychain" : ""}
                onChange={(e) => setPassword(e.target.value)}
              />
              {site.passwordSaved && password === undefined && (
                <button type="button" className="link-button" onClick={() => setPassword("")}>
                  Forget
                </button>
              )}
            </div>
          </label>
        )}

        {site.auth === "key" && (
          <>
            <label className="field span-2">
              <span>Key file</span>
              <div className="input-with-action">
                <input
                  value={site.keyPath}
                  placeholder="~/.ssh/id_ed25519"
                  spellCheck={false}
                  onChange={(e) => set("keyPath", e.target.value)}
                />
                <button type="button" className="button small" onClick={pickKey}>
                  Choose
                </button>
              </div>
              <small className="hint">OpenSSH and PuTTY (.ppk) keys are supported.</small>
            </label>
            <label className="field span-2">
              <span>Key passphrase</span>
              <div className="input-with-action">
                <input
                  type="password"
                  value={passphrase ?? ""}
                  placeholder={
                    site.passphraseSaved && passphrase === undefined ? "Saved in Keychain" : "Leave empty if the key has none"
                  }
                  onChange={(e) => setPassphrase(e.target.value)}
                />
                {site.passphraseSaved && passphrase === undefined && (
                  <button type="button" className="link-button" onClick={() => setPassphrase("")}>
                    Forget
                  </button>
                )}
              </div>
            </label>
          </>
        )}

        <label className="field">
          <span>Remote folder</span>
          <input
            value={site.remoteDir}
            placeholder="Home folder"
            spellCheck={false}
            onChange={(e) => set("remoteDir", e.target.value)}
          />
        </label>
        <label className="field">
          <span>Local folder</span>
          <div className="input-with-action">
            <input
              value={site.localDir}
              placeholder="Unchanged"
              spellCheck={false}
              onChange={(e) => set("localDir", e.target.value)}
            />
            <button type="button" className="button small" onClick={pickLocalDir}>
              Choose
            </button>
          </div>
        </label>

        <label className="field">
          <span>Group</span>
          <input value={site.folder} list="site-folders" placeholder="None" onChange={(e) => set("folder", e.target.value)} />
          <datalist id="site-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <div className="field">
          <span>Color</span>
          <div className="color-picker">
            <button
              type="button"
              className={`color-swatch none${!site.color ? " active" : ""}`}
              title="None"
              onClick={() => set("color", "")}
            />
            {Object.entries(SITE_COLORS).map(([name, value]) => (
              <button
                key={name}
                type="button"
                className={`color-swatch${site.color === name ? " active" : ""}`}
                style={{ background: value }}
                title={name}
                onClick={() => set("color", name)}
              />
            ))}
          </div>
        </div>

        {!isSftp && site.protocol !== "ftp-plain" && (
          <label className="checkbox span-2">
            <input type="checkbox" checked={site.insecureTls} onChange={(e) => set("insecureTls", e.target.checked)} />
            <span>Accept self-signed or mismatched TLS certificates</span>
          </label>
        )}

        <label className="field span-2">
          <span>Notes</span>
          <textarea rows={2} value={site.notes} onChange={(e) => set("notes", e.target.value)} />
        </label>
      </div>
    </Dialog>
  );
}
