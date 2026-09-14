# Integration workflow

Use this workflow for a new Windows desktop application or a migration to the RXW Core protocol.

## 1. Freeze the contract before coding

Record and verify these values in both repositories:

- Stable `appId`: opaque machine contract, such as `visual-library-7f3a9c`; it is not the visible name.
- Visible name: human-facing label, freely readable and potentially similar to another product name.
- Tauri/package identifier: operating-system storage and installation identity, such as `com.company.product`.
- Activation endpoint: currently `https://rxw-core.netlify.app/api/licenses/activate`.
- Protocol version, fingerprint version, component names, weights, threshold, receipt version, algorithm, license type, signing `keyId`, and public key.

Client and server constants must match exactly. Changing an `appId`, fingerprint version, canonicalization rule, hash domain separator, component set, weight, threshold, `keyId`, or public key is a protocol migration, not a cosmetic edit.

Register the application in RXW Core before testing. If the `appId` already exists, verify that it is enabled instead of creating a duplicate. `INVALID_APP` means the record is absent/disabled or the client sent a different `appId`; changing the visible name cannot fix it.

## 2. Separate editions at compile time

Use one source tree and a native feature such as `commercial`:

- Development build: feature absent; returns a licensed development state without reading receipts or contacting RXW Core. Show a visible `DESARROLLO` badge. Keep this build private.
- Commercial build: feature present; requires a valid receipt before protected commands run and shows activation when none exists.

Provide explicit build commands and versioned artifacts for both editions. Confirm which edition was actually compiled by behavior/tests; filenames alone are not proof.

Do not expose a runtime bypass. Keep the license check in native code at every protected entry point, especially the initial data-loading command. The UI gate should avoid mounting protected content until the native state is licensed, sanitize errors, disable duplicate submissions, and cap license input length.

## 3. Activation request

Normalize the license key with Unicode NFKC, remove whitespace, and uppercase it. Serialize a strict request containing only:

```json
{
  "protocolVersion": 2,
  "licenseKey": "…",
  "appId": "stable-app-id",
  "requestId": "uuid",
  "device": {
    "fingerprintVersion": 1,
    "components": {
      "systemUuid": "64 lowercase hex",
      "motherboard": "64 lowercase hex",
      "cpu": "64 lowercase hex",
      "bios": "64 lowercase hex",
      "storage": "64 lowercase hex"
    }
  },
  "client": {
    "appVersion": "x.y.z",
    "platform": "windows",
    "osVersion": "…"
  }
}
```

Use bounded connect and total timeouts, a descriptive user agent, a new request UUID, and a single-process activation lock to avoid duplicate concurrent activation.

The server must require an active application and a license in the correct lifecycle state. Manual flow:

```text
AVAILABLE/creada -> SOLD/habilitada -> ACTIVATED/usada
```

The admin may leave customer, email, order, and reference blank; that must not block `MARK_SOLD`. Those details can be added later. The license key is the entitlement, while `appId` selects the application contract.

## 4. Server result and local receipt

On first protocol-2 activation, RXW Core binds the submitted component hashes, changes the license to `ACTIVATED`, creates an activation/binding identifier, and returns `activationReceipt` signed with Ed25519.

The client must verify the receipt before saving it. Save it under the Tauri local application data directory in `licensing/license.rxw`; do not place it beside the user's library. Bound size, require a regular file, serialize only verified JSON, write to a unique temporary file, flush/sync, and atomically replace the final receipt. Remove an incomplete temporary file after failure.

Later starts need no network: load the receipt, recollect and hash the current hardware, verify the signature and signed policy, and calculate the device score. Do not silently accept a malformed, tampered, wrong-app, wrong-key, or wrong-device receipt.

## 5. License lifecycle operations

- Same valid machine: reopening uses the local receipt; replaying online activation is idempotent and may update last-seen metadata.
- Materially different machine: reject with `DEVICE_MISMATCH` or the equivalent other-device error.
- Hardware maintenance: weighted matching may tolerate low-weight changes such as storage while rejecting changes that fall below the signed threshold.
- Transfer to another computer: release the device/license in RXW Core first, then activate on the new computer. Do not copy `license.rxw` as a transfer mechanism.
- Blocked or revoked: online activation rejects it. Define separately whether already-issued perpetual offline receipts are expected to remain valid; changing that behavior requires an explicit revocation/online-check design decision.

## 6. User-facing errors

Map server codes to a small allowlist of plain messages. Never display server payloads, filesystem paths, keys, stack traces, WMI values, or cryptographic details. Unknown errors map to a generic validation failure.

At minimum distinguish invalid key, not habilitated, wrong application, other device, device mismatch, blocked, revoked, internet required, server unavailable, computer identification unavailable, and receipt storage unavailable.
