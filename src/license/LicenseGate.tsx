import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, Loader2, LockKeyhole } from "lucide-react";
import { activateLicense, getLicenseState, type LicenseState } from "../lib/api";

const SAFE_MESSAGES = new Set([
  "La licencia no es válida",
  "La licencia todavía no fue habilitada",
  "La licencia no corresponde a Biblioteca Visual",
  "La licencia está activada en otro dispositivo",
  "Esta computadora no coincide con la autorizada",
  "La licencia está bloqueada",
  "La licencia fue revocada",
  "Necesitás internet para activar Biblioteca Visual",
  "No fue posible validar la licencia. Intentá nuevamente",
  "No fue posible identificar esta computadora",
  "No fue posible guardar la activación en esta computadora",
]);

function safeMessage(value: unknown) {
  const message = typeof value === "string" ? value.trim() : "";
  return SAFE_MESSAGES.has(message)
    ? message
    : "No fue posible validar la licencia. Intentá nuevamente";
}

export function LicenseGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LicenseState | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    void getLicenseState()
      .then((next) => {
        if (!disposed) {
          setState(next);
          setError(next.message ? safeMessage(next.message) : null);
        }
      })
      .catch(() => {
        if (!disposed) {
          setState({ edition: "commercial", status: "invalid", message: null, licensedTo: null });
          setError("No fue posible validar la licencia. Intentá nuevamente");
        }
      });
    return () => { disposed = true; };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !licenseKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const next = await activateLicense(licenseKey);
      setState(next);
      setLicenseKey("");
    } catch (activationError) {
      setError(safeMessage(activationError));
    } finally {
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <main className="license-shell license-loading" aria-live="polite">
        <Loader2 className="spin" size={28} />
        <span>Comprobando Biblioteca Visual…</span>
      </main>
    );
  }

  if (state.status === "licensed") {
    return (
      <>
        {children}
        {state.edition === "development" && (
          <div className="development-edition-badge" title="Compilación privada sin bloqueo de licencia">
            DESARROLLO
          </div>
        )}
      </>
    );
  }

  return (
    <main className="license-shell">
      <section className="license-card" aria-labelledby="license-title">
        <div className="license-heading">
          <h1 id="license-title">Activar Biblioteca Visual</h1>
          <p>Ingresá la licencia habilitada para esta aplicación. La primera activación necesita internet; después podrás abrirla sin conexión en esta computadora.</p>
        </div>

        <form onSubmit={submit} className="license-form">
          <label htmlFor="license-key">Licencia</label>
          <div className="license-input-wrap">
            <KeyRound size={18} aria-hidden="true" />
            <input
              id="license-key"
              value={licenseKey}
              onChange={(event) => setLicenseKey(event.target.value.slice(0, 96))}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXX"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              autoFocus
            />
          </div>
          {error && <div className="license-error" role="alert">{error}</div>}
          <button type="submit" disabled={busy || !licenseKey.trim()}>
            {busy ? <Loader2 className="spin" size={18} /> : <LockKeyhole size={18} />}
            {busy ? "Validando…" : "Activar aplicación"}
          </button>
        </form>

      </section>
    </main>
  );
}
