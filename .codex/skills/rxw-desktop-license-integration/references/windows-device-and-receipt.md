# Windows device fingerprint and signed receipt

## Current RXW fingerprint v1

The current RXW contract uses five logical components and a score of 100:

| Component | Windows source | Weight |
|---|---|---:|
| `systemUuid` | `Win32_ComputerSystemProduct.UUID` | 30 |
| `motherboard` | manufacturer, product, serial from `Win32_BaseBoard` | 30 |
| `cpu` | processor ID and name from `Win32_Processor` | 20 |
| `bios` | serial and SMBIOS version from `Win32_BIOS` | 15 |
| `storage` | serial and model of `Win32_DiskDrive WHERE Index = 0` | 5 |

Default match threshold: 70. Therefore replacing only storage remains the same machine; changing motherboard plus CPU does not. Keep client and server weights and threshold identical and sign the policy inside the receipt.

Normalize each raw field with NFKC, trim, discard empty values, sort case-insensitively, deduplicate, and join deterministically. Never send raw values. Hash each logical component as lowercase SHA-256 using this exact byte sequence:

```text
rxw-fingerprint-component-v1\0<component-name>\0<normalized-value>
```

Return exactly five 64-character lowercase hashes. If a WMI category is absent, use a deterministic fallback derived from the available machine values only if that rule is implemented identically and covered by tests. If no usable hardware values exist, fail closed with `DeviceUnavailable`.

## Critical WMI/COM threading rule

WMI initializes COM. In a Tauri command, a synchronous call can run in a UI/IPC thread whose COM apartment is incompatible or already initialized differently. The symptom can be misleading: activation succeeds, but the next protected startup call returns `No fue posible identificar esta computadora`.

Any command that directly or indirectly calls WMI must move the entire blocking operation to a worker thread:

```rust
#[tauri::command]
async fn get_initial_state(app: AppHandle) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || get_initial_state_blocking(app))
        .await
        .map_err(to_string)?
}

fn get_initial_state_blocking(app: AppHandle) -> Result<Response, String> {
    license::require_license(&app)?;
    // Continue the blocking database/filesystem work here.
}
```

Apply the same shape to `get_license_state` and `activate_license`. Do not initialize a WMI connection on one thread and use it on another. Do not fix this by weakening or skipping device verification.

## Receipt verification

The server signs canonical JSON with Ed25519. Canonicalization recursively sorts object keys and emits compact JSON. The client must reproduce that algorithm exactly and verify the signature before trusting any payload field.

The current receipt contract requires:

- `receiptVersion: 1`
- `algorithm: Ed25519`
- expected production `keyId`
- SHA-256 license-key hash
- exact `appId`
- activation and binding identifiers
- `fingerprintVersion: 1`
- all five bound component hashes
- signed device policy and threshold
- ISO issue timestamp
- `licenseType: PERPETUAL`
- `validUntil: null`

Embed only an Ed25519 SPKI public key in the client. Test that it parses as Ed25519. A new production key requires a deliberate key rotation/migration plan; replacing the public key invalidates receipts signed by the old key unless multiple trusted keys are supported.

Keep the RXW license-signing key separate from the Tauri updater key:

- RXW key signs activation receipts and lives only in RXW Core production secrets.
- Tauri updater key signs installers/update artifacts and lives outside the repository or in the release system.

Never log, print, commit, paste, or upload either private key or its password.
