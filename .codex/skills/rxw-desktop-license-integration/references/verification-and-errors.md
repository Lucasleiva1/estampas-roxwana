# Verification and troubleshooting

## Automated verification

Run the client's normal frontend tests, native tests without the commercial feature, native tests with the commercial feature, and production builds. Add focused tests for:

- Development edition opens without a receipt and visibly identifies itself.
- Commercial edition does not mount protected content before licensing.
- Unknown/internal errors are replaced by safe messages.
- Public fingerprint vectors hash identically on client and RXW Core.
- Signed public receipt vector verifies.
- Tampered receipt, wrong `appId`, wrong `keyId`, malformed fields, and different machine are rejected.
- A permitted low-weight hardware change remains accepted.
- Exactly five hashed components are produced on a real Windows machine.
- Receipt replacement is atomic and incomplete temporary files are not accepted.
- Protected initial state calls the native license check from a `spawn_blocking` path.

Run RXW Core tests for application registration, state transitions, protocol-2 input validation, device comparison, receipt signing/verification, idempotent replay, device release/rebind, concurrency, storage conflicts, and sanitization.

## Mandatory end-to-end test

1. Verify exact client binary path, edition, file/product version, repository identity, and RXW Core production identity.
2. Preserve the owner's development installation. If editions share an installer identifier, use the versioned portable commercial executable.
3. Back up an existing `license.rxw` by moving it to a clearly named file in the same licensing directory; never delete it silently.
4. In RXW Core, register/enable the exact `appId`, create a fresh key, save it, and habilitate it with all customer fields empty if desired.
5. Confirm the pre-activation state is HABILITADA/SOLD.
6. Open the exact new commercial build. The user may paste the key personally.
7. Confirm the protected application opens without a red device-identification message.
8. Refresh RXW Core. Confirm the exact key is USADA/ACTIVATED and shows a new device binding. A stale list is a UI refresh issue if the dashboard count or refreshed row already shows ACTIVATED.
9. Close only the exact commercial process, verify its executable path, reopen the same version, and confirm it opens from the local signed receipt.
10. When appropriate, disconnect networking after a successful activation and verify offline startup.
11. Optionally confirm the same key is rejected on another computer until the binding is released.

Do not use a mocked fingerprint or a developer bypass as the final proof.

## Failure guide

| Symptom/code | Likely cause | Check/fix |
|---|---|---|
| `INVALID_APP` | Missing/disabled application or mismatched `appId` | Compare the exact client constant with RXW Core; do not change the visible name as a workaround. |
| `LICENSE_NOT_SOLD` / not habilitated | Key is AVAILABLE/RESERVED | Perform the authorized Habilitar/MARK_SOLD action; customer fields remain optional. |
| `LICENSE_ALREADY_ACTIVATED_OTHER_DEVICE` | Legacy or active binding belongs elsewhere | Release through RXW Core before a new activation. |
| `DEVICE_MISMATCH` | Score is below signed threshold | Inspect which hashed logical components changed; do not lower the threshold ad hoc. |
| `No fue posible identificar esta computadora` on every path | WMI unavailable, permissions/system issue, or no hardware values | Test fingerprint collection on the target Windows machine. |
| Same message only after entering the app | Protected startup calls WMI synchronously on a Tauri IPC/UI thread | Move the entire command path, including `require_license`, into `spawn_blocking`. |
| Activation succeeds but RXW row still says HABILITADA | Admin list is stale or projection is delayed | Refresh the license list and inspect the exact key/device binding before changing code. |
| Receipt works until another edition is installed | Editions share Tauri identifier/data paths | Stop; identify the executable and storage directory. Do not uninstall/overwrite the owner's edition. Decide identity separation only with user approval. |
| Receipt rejected as invalid | Signature/key/canonical JSON/policy/field mismatch or corruption | Compare executable contracts and public test vectors; do not accept malformed data. |
| Cannot save activation | Local-data permissions, antivirus, incomplete write | Verify app-local licensing directory and atomic-write behavior; preserve existing receipt. |
| Works in development but not commercial | Wrong feature/build or untested commercial path | Test `--features commercial` and inspect the exact artifact metadata. |

## Completion evidence

Report the exact client version/edition, commit/tag when published, automated test totals, commercial artifact names, activation state before/after, device binding presence, receipt persistence/reopen result, and any intentionally preserved backup. Never include private keys, passwords, raw hardware identifiers, session credentials, or full customer-sensitive data.
