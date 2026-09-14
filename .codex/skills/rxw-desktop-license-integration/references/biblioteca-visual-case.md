# Biblioteca Visual case record

This is a dated implementation record, not a substitute for checking the current repositories.

## Verified baseline on 2026-09-14

- Client root: `D:\PAGINAS WEB Y APP\estampas-roxwana`
- Client repository: `https://github.com/Lucasleiva1/estampas-roxwana.git`
- Package: `roxwana-biblioteca-visual`
- Product: `ROXWANA Biblioteca Visual`
- Tauri identifier: `com.roxwana.biblioteca-visual`
- RXW Core root: `D:\PAGINAS WEB Y APP\rxw-core`
- RXW Core repository: `https://github.com/Lucasleiva1/rxw-core.git`
- Stable RXW `appId`: `biblioteca-visual`
- Activation endpoint: `https://rxw-core.netlify.app/api/licenses/activate`
- Protocol: 2
- Fingerprint: version 1, five component hashes, threshold 70
- Receipt: version 1, Ed25519, perpetual, production `keyId` `rxw-signing-prod-2026-01`
- Corrected client version: 0.1.22
- Correcting commit: `563149c0f6c043640f2c36849fee623517c7ac8d`
- Release tag: `app-v0.1.22`

The local receipt resolves from the Tauri app-local data directory and on the verified machine was stored under:

```text
%LOCALAPPDATA%\com.roxwana.biblioteca-visual\licensing\license.rxw
```

Never hard-code that expanded user path; resolve it through Tauri.

## Architecture used

- `src-tauri/src/license.rs`: feature gate, RXW request, WMI fingerprint, receipt verification and atomic storage.
- `src-tauri/src/main.rs`: Tauri commands and protected `get_initial_state` enforcement.
- `src/license/LicenseGate.tsx`: activation UI and safe error allowlist.
- `src/lib/api.ts`: typed invoke wrappers.
- `tests/license-gate.test.tsx` and Rust unit tests: gate, vectors, tamper/wrong-app/wrong-device, edition behavior, WMI hashes, atomic write.
- `tools/build-edition.mjs`: explicit development/commercial builds and non-overwriting versioned artifacts.
- `src-tauri/tauri.development.conf.json` and `src-tauri/tauri.commercial.conf.json`: edition-specific product presentation/build behavior.

## Failure that must not recur

Version 0.1.21 could activate and enter the library, but then displayed:

```text
No fue posible identificar esta computadora
```

The hardware algorithm itself was not removed or weakened. The defect was execution context: `get_license_state` and `activate_license` already used `spawn_blocking`, while `get_initial_state` synchronously called `license::require_license`. That second receipt verification recollected WMI hardware from a Tauri IPC/UI thread and could fail COM initialization.

The 0.1.22 fix changed `get_initial_state` to an async command that moves the entire original implementation into `spawn_blocking`, with `require_license` inside the worker. The real commercial test then:

- accepted a fresh habilitated key;
- opened without the red identification error;
- created a new local receipt;
- changed the RXW Core row from HABILITADA to USADA;
- displayed a `binding-…` device identifier in RXW Core.

Do not “fix” this symptom by skipping startup verification, accepting a missing fingerprint, using a random per-install ID, or loosening the score.

## Known operational traps

- An earlier transfer document stated `fingerprintVersion: 2`; the executable client and RXW Core production code verified on 2026-09-14 both use version 1. Reinspect code before every future integration and update stale documentation rather than copying it.
- The visible name `Biblioteca Visual` is not the authorization identifier. RXW uses exact `appId = biblioteca-visual`.
- Development and commercial binaries currently share the Tauri identifier. Installing one may collide with the other. The successful commercial test used the versioned portable executable and never uninstalled the owner's development edition.
- RXW Core may already have accepted activation while the Licencias table remains stale. Refreshing showed the key as USADA and the dashboard count increased.
- Manual Habilitar originally demanded email/customer data. RXW Core 0.8.3 was corrected so every customer/order field is optional, the license can be habilitated with no data, and details can be added later.
- Local commercial artifacts and GitHub updater artifacts serve different purposes. Commercial builds use the `commercial` feature; the owner's signed updater release must follow the project's separate release skill and must never expose the development build to customers unintentionally.

## Minimum regression commands

From the verified client root:

```powershell
npm.cmd test
cargo test --manifest-path src-tauri\Cargo.toml --features commercial
npm.cmd run build
npm.cmd run build:commercial
```

Then perform the mandatory end-to-end test in `verification-and-errors.md`. Automated results for 0.1.22 were 41 frontend tests and 58 native commercial tests passed.
