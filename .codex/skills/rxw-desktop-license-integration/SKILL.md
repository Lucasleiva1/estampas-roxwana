---
name: rxw-desktop-license-integration
description: Integrate or repair RXW Core device-bound licensing in Windows desktop applications, especially Tauri clients. Use for app registration, stable appId contracts, commercial/development editions, hardware fingerprints, activation receipts, offline validation, license gates, device mismatch errors, or end-to-end activation tests. Do not use for release signing alone.
---

# RXW Desktop License Integration

Implement a commercial license gate that is enforced in native code, binds one license to one Windows computer, activates through RXW Core, and later opens offline only after verifying a signed local receipt.

## Non-negotiable invariants

- Treat the visible application name, stable `appId`, Tauri/package identifier, and generated license key as four different values. The client and RXW Core must use the exact same stable `appId`; similarity of visible names is irrelevant.
- Keep the RXW Core license-signing private key only in the server environment. Embed only its public Ed25519 key and expected `keyId` in the client. Never confuse this key pair with Tauri updater signing keys.
- Enforce the license in native/backend code before protected data loads. A React-only gate is presentation, not enforcement.
- Build development and commercial editions through a compile-time feature. A production user must not be able to disable licensing with an environment variable, preference, command-line flag, or UI option.
- Hash hardware components locally before transmission. Do not transmit raw serial numbers, UUIDs, board data, or other raw hardware identifiers.
- Validate the signed receipt locally on every protected startup: signature, receipt format, application, key identity, license type, signed device policy, and current-device match.
- Any Tauri command that can initialize WMI/COM, including indirect calls through `require_license`, must execute the complete blocking path inside `tauri::async_runtime::spawn_blocking`. This is mandatory after the Biblioteca Visual 0.1.21 failure.
- Never claim success from unit tests alone. Perform a fresh commercial activation, confirm RXW Core changes from habilitada/SOLD to usada/ACTIVATED with a device binding, then close and reopen the same binary.

## Start every integration

1. Verify the expected client and RXW Core repositories: absolute root, Git root, branch, `origin`, product/package identity, current version, and production endpoint. Stop on any mismatch.
2. Inspect the current RXW Core protocol and fingerprint configuration. Do not trust an old handoff document over executable code.
3. Choose a stable, opaque `appId` supplied by the application owner. Register it once in RXW Core with a separate visible name. Never derive authorization from the visible name.
4. Read [references/integration-workflow.md](references/integration-workflow.md) before implementing or migrating a client.
5. Read [references/windows-device-and-receipt.md](references/windows-device-and-receipt.md) when touching WMI, fingerprinting, matching, receipts, storage, or cryptography.
6. Read [references/verification-and-errors.md](references/verification-and-errors.md) before testing, distributing, or diagnosing an activation.
7. For Biblioteca Visual specifically, also read [references/biblioteca-visual-case.md](references/biblioteca-visual-case.md).

## Scope and authorization

- Prefer a local client fix when the server contract is correct. Do not modify RXW Core merely because a client failed.
- Registering an application, creating/habilitating a license, releasing a device, pushing code, deploying RXW Core, or publishing a release changes external state; require the user's request or confirmation appropriate to the tool in use.
- Customer, email, order, and reference fields may be shown but must remain optional for manual license creation/habilitation. Preserve them as undefined/null when omitted and allow later editing.
- If development and commercial installers share the same Tauri identifier, installing one can replace or open the other. Do not uninstall or overwrite the owner's development edition. Use a versioned portable commercial executable for tests unless the user explicitly approves an identity or installation strategy change.
