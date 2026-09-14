use base64::{engine::general_purpose, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const APP_ID: &str = "biblioteca-visual";
const ACTIVATION_ENDPOINT: &str = "https://rxw-core.netlify.app/api/licenses/activate";
const RECEIPT_FILE_NAME: &str = "license.rxw";
const RECEIPT_MAX_BYTES: u64 = 128 * 1024;
const PRODUCTION_KEY_ID: &str = "rxw-signing-prod-2026-01";
const PRODUCTION_PUBLIC_KEY: &str = include_str!("../keys/rxw-signing-prod-2026-01.public.pem");
const COMPONENT_NAMES: [&str; 5] = ["systemUuid", "motherboard", "cpu", "bios", "storage"];
const COMPONENT_WEIGHTS: [(&str, u64); 5] = [
    ("systemUuid", 30),
    ("motherboard", 30),
    ("cpu", 20),
    ("bios", 15),
    ("storage", 5),
];
const DEVICE_THRESHOLD: u64 = 70;
static ACTIVATION_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseState {
    pub edition: &'static str,
    pub status: &'static str,
    pub message: Option<String>,
    pub licensed_to: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFingerprint {
    pub fingerprint_version: u64,
    pub components: BTreeMap<String, String>,
}

#[derive(Debug)]
enum LicenseFailure {
    Invalid,
    WrongApp,
    WrongDevice,
    NotEnabled,
    OtherDevice,
    Blocked,
    Revoked,
    InternetRequired,
    ServerUnavailable,
    DeviceUnavailable,
    StorageUnavailable,
}

impl LicenseFailure {
    fn message(&self) -> &'static str {
        match self {
            Self::Invalid => "La licencia no es válida",
            Self::WrongApp => "La licencia no corresponde a Biblioteca Visual",
            Self::WrongDevice => "Esta computadora no coincide con la autorizada",
            Self::NotEnabled => "La licencia todavía no fue habilitada",
            Self::OtherDevice => "La licencia está activada en otro dispositivo",
            Self::Blocked => "La licencia está bloqueada",
            Self::Revoked => "La licencia fue revocada",
            Self::InternetRequired => "Necesitás internet para activar Biblioteca Visual",
            Self::ServerUnavailable => "No fue posible validar la licencia. Intentá nuevamente",
            Self::DeviceUnavailable => "No fue posible identificar esta computadora",
            Self::StorageUnavailable => "No fue posible guardar la activación en esta computadora",
        }
    }
}

pub fn get_license_state(app: AppHandle) -> LicenseState {
    if !cfg!(feature = "commercial") {
        return development_state();
    }

    match load_and_verify_receipt(&app) {
        Ok(()) => licensed_state(None),
        Err(LicenseFailure::StorageUnavailable) => activation_state(
            "invalid",
            Some(LicenseFailure::StorageUnavailable.message().to_string()),
        ),
        Err(LicenseFailure::WrongApp) => activation_state(
            "invalid",
            Some(LicenseFailure::WrongApp.message().to_string()),
        ),
        Err(LicenseFailure::WrongDevice) => activation_state(
            "invalid",
            Some(LicenseFailure::WrongDevice.message().to_string()),
        ),
        Err(LicenseFailure::DeviceUnavailable) => activation_state(
            "invalid",
            Some(LicenseFailure::DeviceUnavailable.message().to_string()),
        ),
        Err(_) => activation_state("activationRequired", None),
    }
}

pub fn activate_license(app: AppHandle, license_key: String) -> Result<LicenseState, String> {
    if !cfg!(feature = "commercial") {
        return Ok(development_state());
    }

    let _guard = ACTIVATION_LOCK
        .lock()
        .map_err(|_| LicenseFailure::ServerUnavailable.message().to_string())?;
    activate_commercial(&app, &license_key).map_err(|error| error.message().to_string())
}

pub fn require_license(app: &AppHandle) -> Result<(), String> {
    if !cfg!(feature = "commercial") {
        return Ok(());
    }
    load_and_verify_receipt(app).map_err(|error| error.message().to_string())
}

fn development_state() -> LicenseState {
    LicenseState {
        edition: "development",
        status: "licensed",
        message: None,
        licensed_to: None,
    }
}

fn licensed_state(licensed_to: Option<String>) -> LicenseState {
    LicenseState {
        edition: "commercial",
        status: "licensed",
        message: None,
        licensed_to,
    }
}

fn activation_state(status: &'static str, message: Option<String>) -> LicenseState {
    LicenseState {
        edition: "commercial",
        status,
        message,
        licensed_to: None,
    }
}

fn activate_commercial(app: &AppHandle, raw_key: &str) -> Result<LicenseState, LicenseFailure> {
    let license_key = normalize_license_key(raw_key);
    if license_key.is_empty() {
        return Err(LicenseFailure::Invalid);
    }

    let fingerprint = collect_device_fingerprint()?;
    let os_version = windows_version().unwrap_or_else(|| "Windows".to_string());
    let request = json!({
        "protocolVersion": 2,
        "licenseKey": license_key,
        "appId": APP_ID,
        "requestId": Uuid::new_v4().to_string(),
        "device": fingerprint,
        "client": {
            "appVersion": env!("CARGO_PKG_VERSION"),
            "platform": "windows",
            "osVersion": os_version,
        }
    });

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(25))
        .user_agent(format!("Biblioteca-Visual/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| LicenseFailure::ServerUnavailable)?;
    let response = client
        .post(ACTIVATION_ENDPOINT)
        .json(&request)
        .send()
        .map_err(|error| {
            if error.is_connect() || error.is_timeout() {
                LicenseFailure::InternetRequired
            } else {
                LicenseFailure::ServerUnavailable
            }
        })?;
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|_| LicenseFailure::ServerUnavailable)?;

    if !status.is_success() || body.get("ok").and_then(Value::as_bool) != Some(true) {
        let code = body
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Err(map_server_error(code, status.is_server_error()));
    }

    let data = body.get("data").ok_or(LicenseFailure::Invalid)?;
    let receipt = data
        .get("activationReceipt")
        .ok_or(LicenseFailure::Invalid)?;
    verify_receipt(
        receipt,
        &fingerprint,
        PRODUCTION_PUBLIC_KEY,
        APP_ID,
        Some(PRODUCTION_KEY_ID),
    )?;
    save_receipt(app, receipt)?;

    let licensed_to = data
        .pointer("/licensedTo/displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned);
    Ok(licensed_state(licensed_to))
}

fn normalize_license_key(value: &str) -> String {
    value
        .nfkc()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_uppercase)
        .collect()
}

fn map_server_error(code: &str, server_error: bool) -> LicenseFailure {
    match code {
        "INVALID_LICENSE_FORMAT" | "LICENSE_NOT_FOUND" => LicenseFailure::Invalid,
        "LICENSE_NOT_SOLD" | "LICENSE_NOT_DELIVERED" => LicenseFailure::NotEnabled,
        "INVALID_APP" => LicenseFailure::WrongApp,
        "LICENSE_ALREADY_ACTIVATED_OTHER_DEVICE" | "DEVICE_RELEASE_REQUIRED" => {
            LicenseFailure::OtherDevice
        }
        "DEVICE_MISMATCH" => LicenseFailure::WrongDevice,
        "LICENSE_BLOCKED" => LicenseFailure::Blocked,
        "LICENSE_REVOKED" => LicenseFailure::Revoked,
        _ if server_error => LicenseFailure::ServerUnavailable,
        _ => LicenseFailure::Invalid,
    }
}

fn receipt_path(app: &AppHandle) -> Result<PathBuf, LicenseFailure> {
    app.path()
        .app_local_data_dir()
        .map(|directory| directory.join("licensing").join(RECEIPT_FILE_NAME))
        .map_err(|_| LicenseFailure::StorageUnavailable)
}

fn load_and_verify_receipt(app: &AppHandle) -> Result<(), LicenseFailure> {
    let path = receipt_path(app)?;
    let metadata = fs::metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            LicenseFailure::Invalid
        } else {
            LicenseFailure::StorageUnavailable
        }
    })?;
    if !metadata.is_file() || metadata.len() > RECEIPT_MAX_BYTES {
        return Err(LicenseFailure::Invalid);
    }
    let contents = fs::read_to_string(path).map_err(|_| LicenseFailure::StorageUnavailable)?;
    let receipt: Value = serde_json::from_str(&contents).map_err(|_| LicenseFailure::Invalid)?;
    let fingerprint = collect_device_fingerprint()?;
    verify_receipt(
        &receipt,
        &fingerprint,
        PRODUCTION_PUBLIC_KEY,
        APP_ID,
        Some(PRODUCTION_KEY_ID),
    )
}

fn save_receipt(app: &AppHandle, receipt: &Value) -> Result<(), LicenseFailure> {
    let target = receipt_path(app)?;
    let directory = target.parent().ok_or(LicenseFailure::StorageUnavailable)?;
    fs::create_dir_all(directory).map_err(|_| LicenseFailure::StorageUnavailable)?;
    let bytes = serde_json::to_vec(receipt).map_err(|_| LicenseFailure::Invalid)?;
    if bytes.len() as u64 > RECEIPT_MAX_BYTES {
        return Err(LicenseFailure::Invalid);
    }

    let temporary = directory.join(format!(
        ".{RECEIPT_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| LicenseFailure::StorageUnavailable)?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| LicenseFailure::StorageUnavailable)?;
        drop(file);
        replace_complete_file(&temporary, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn replace_complete_file(temporary: &Path, target: &Path) -> Result<(), LicenseFailure> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };

        let source = temporary
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let destination = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        (moved != 0)
            .then_some(())
            .ok_or(LicenseFailure::StorageUnavailable)
    }

    #[cfg(not(windows))]
    fs::rename(temporary, target).map_err(|_| LicenseFailure::StorageUnavailable)
}

fn verify_receipt(
    receipt: &Value,
    fingerprint: &DeviceFingerprint,
    public_key_pem: &str,
    expected_app_id: &str,
    expected_key_id: Option<&str>,
) -> Result<(), LicenseFailure> {
    let payload = receipt.get("payload").ok_or(LicenseFailure::Invalid)?;
    let signature_text = receipt
        .get("signature")
        .and_then(Value::as_str)
        .ok_or(LicenseFailure::Invalid)?;

    let canonical_payload = canonicalize_json(payload)?;
    let signature_bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(signature_text)
        .or_else(|_| general_purpose::URL_SAFE.decode(signature_text))
        .map_err(|_| LicenseFailure::Invalid)?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|_| LicenseFailure::Invalid)?;
    let verifying_key = verifying_key_from_pem(public_key_pem)?;
    verifying_key
        .verify_strict(canonical_payload.as_bytes(), &signature)
        .map_err(|_| LicenseFailure::Invalid)?;

    if payload.get("receiptVersion").and_then(Value::as_u64) != Some(1)
        || payload.get("algorithm").and_then(Value::as_str) != Some("Ed25519")
        || payload.get("licenseType").and_then(Value::as_str) != Some("PERPETUAL")
        || payload.get("validUntil") != Some(&Value::Null)
        || payload.get("fingerprintVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err(LicenseFailure::Invalid);
    }
    if payload.get("appId").and_then(Value::as_str) != Some(expected_app_id) {
        return Err(LicenseFailure::WrongApp);
    }
    if let Some(expected_key_id) = expected_key_id {
        if payload.get("keyId").and_then(Value::as_str) != Some(expected_key_id) {
            return Err(LicenseFailure::Invalid);
        }
    }
    verify_signed_policy(payload.get("devicePolicy"))?;

    let bound_components = payload
        .pointer("/deviceBinding/components")
        .and_then(Value::as_object)
        .ok_or(LicenseFailure::Invalid)?;
    if bound_components.len() != COMPONENT_NAMES.len() || fingerprint.fingerprint_version != 1 {
        return Err(LicenseFailure::Invalid);
    }
    let mut score = 0;
    for (name, weight) in COMPONENT_WEIGHTS {
        let bound = bound_components
            .get(name)
            .and_then(Value::as_str)
            .filter(|hash| is_sha256_hex(hash))
            .ok_or(LicenseFailure::Invalid)?;
        let current = fingerprint
            .components
            .get(name)
            .filter(|hash| is_sha256_hex(hash))
            .ok_or(LicenseFailure::Invalid)?;
        if bound == current {
            score += weight;
        }
    }
    if score < DEVICE_THRESHOLD {
        return Err(LicenseFailure::WrongDevice);
    }
    Ok(())
}

fn verify_signed_policy(policy: Option<&Value>) -> Result<(), LicenseFailure> {
    let expected = json!({
        "version": 1,
        "threshold": DEVICE_THRESHOLD,
        "weights": {
            "systemUuid": 30,
            "motherboard": 30,
            "cpu": 20,
            "bios": 15,
            "storage": 5
        }
    });
    if policy == Some(&expected) {
        Ok(())
    } else {
        Err(LicenseFailure::Invalid)
    }
}

fn canonicalize_json(value: &Value) -> Result<String, LicenseFailure> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
            serde_json::to_string(value).map_err(|_| LicenseFailure::Invalid)
        }
        Value::Array(values) => {
            let items = values
                .iter()
                .map(canonicalize_json)
                .collect::<Result<Vec<_>, _>>()?;
            Ok(format!("[{}]", items.join(",")))
        }
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            let fields = entries
                .into_iter()
                .map(|(key, value)| {
                    let key = serde_json::to_string(key).map_err(|_| LicenseFailure::Invalid)?;
                    Ok(format!("{key}:{}", canonicalize_json(value)?))
                })
                .collect::<Result<Vec<_>, LicenseFailure>>()?;
            Ok(format!("{{{}}}", fields.join(",")))
        }
    }
}

fn verifying_key_from_pem(pem: &str) -> Result<VerifyingKey, LicenseFailure> {
    let encoded = pem
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with("-----") && !line.is_empty())
        .collect::<String>();
    let der = general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| LicenseFailure::Invalid)?;
    const ED25519_SPKI_PREFIX: [u8; 12] = [
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    if der.len() != ED25519_SPKI_PREFIX.len() + 32
        || der[..ED25519_SPKI_PREFIX.len()] != ED25519_SPKI_PREFIX
    {
        return Err(LicenseFailure::Invalid);
    }
    let key: [u8; 32] = der[ED25519_SPKI_PREFIX.len()..]
        .try_into()
        .map_err(|_| LicenseFailure::Invalid)?;
    VerifyingKey::from_bytes(&key).map_err(|_| LicenseFailure::Invalid)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|character| character.is_ascii_digit() || (b'a'..=b'f').contains(&character))
}

fn hash_component(name: &str, raw_value: &str) -> Result<String, LicenseFailure> {
    if !COMPONENT_NAMES.contains(&name) {
        return Err(LicenseFailure::DeviceUnavailable);
    }
    let normalized = raw_value.nfkc().collect::<String>().trim().to_lowercase();
    if normalized.is_empty()
        || normalized.len() > 512
        || normalized.chars().any(|character| character.is_control())
    {
        return Err(LicenseFailure::DeviceUnavailable);
    }
    let mut hasher = Sha256::new();
    hasher.update(b"rxw-fingerprint-component-v1\0");
    hasher.update(name.as_bytes());
    hasher.update(b"\0");
    hasher.update(normalized.as_bytes());
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(windows)]
fn collect_device_fingerprint() -> Result<DeviceFingerprint, LicenseFailure> {
    use wmi::{COMLibrary, WMIConnection};

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct ComputerSystemProduct {
        uuid: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct BaseBoard {
        manufacturer: Option<String>,
        product: Option<String>,
        serial_number: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Processor {
        processor_id: Option<String>,
        name: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Bios {
        serial_number: Option<String>,
        smbiosbios_version: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct DiskDrive {
        serial_number: Option<String>,
        model: Option<String>,
    }

    let com = COMLibrary::new().map_err(|_| LicenseFailure::DeviceUnavailable)?;
    let connection = WMIConnection::new(com).map_err(|_| LicenseFailure::DeviceUnavailable)?;
    let system: Vec<ComputerSystemProduct> = connection
        .raw_query("SELECT UUID FROM Win32_ComputerSystemProduct")
        .map_err(|_| LicenseFailure::DeviceUnavailable)?;
    let boards: Vec<BaseBoard> = connection
        .raw_query("SELECT Manufacturer, Product, SerialNumber FROM Win32_BaseBoard")
        .map_err(|_| LicenseFailure::DeviceUnavailable)?;
    let processors: Vec<Processor> = connection
        .raw_query("SELECT ProcessorId, Name FROM Win32_Processor")
        .map_err(|_| LicenseFailure::DeviceUnavailable)?;
    let bios_rows: Vec<Bios> = connection
        .raw_query("SELECT SerialNumber, SMBIOSBIOSVersion FROM Win32_BIOS")
        .map_err(|_| LicenseFailure::DeviceUnavailable)?;
    let disks: Vec<DiskDrive> = connection
        .raw_query("SELECT SerialNumber, Model FROM Win32_DiskDrive WHERE Index = 0")
        .map_err(|_| LicenseFailure::DeviceUnavailable)?;

    let mut raw = BTreeMap::new();
    raw.insert(
        "systemUuid",
        stable_values(system.into_iter().flat_map(|row| [row.uuid])),
    );
    raw.insert(
        "motherboard",
        stable_values(
            boards
                .into_iter()
                .flat_map(|row| [row.manufacturer, row.product, row.serial_number]),
        ),
    );
    raw.insert(
        "cpu",
        stable_values(
            processors
                .into_iter()
                .flat_map(|row| [row.processor_id, row.name]),
        ),
    );
    raw.insert(
        "bios",
        stable_values(
            bios_rows
                .into_iter()
                .flat_map(|row| [row.serial_number, row.smbiosbios_version]),
        ),
    );
    raw.insert(
        "storage",
        stable_values(
            disks
                .into_iter()
                .flat_map(|row| [row.serial_number, row.model]),
        ),
    );

    let available = raw
        .values()
        .filter_map(|value| value.as_deref())
        .collect::<Vec<_>>()
        .join("|");
    if available.is_empty() {
        return Err(LicenseFailure::DeviceUnavailable);
    }
    let components = COMPONENT_NAMES
        .into_iter()
        .map(|name| {
            let value = raw
                .get(name)
                .and_then(|value| value.as_deref())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("unavailable:{name}:{available}"));
            Ok((name.to_string(), hash_component(name, &value)?))
        })
        .collect::<Result<BTreeMap<_, _>, LicenseFailure>>()?;
    Ok(DeviceFingerprint {
        fingerprint_version: 1,
        components,
    })
}

#[cfg(not(windows))]
fn collect_device_fingerprint() -> Result<DeviceFingerprint, LicenseFailure> {
    Err(LicenseFailure::DeviceUnavailable)
}

fn stable_values(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    let mut values = values
        .into_iter()
        .flatten()
        .map(|value| value.nfkc().collect::<String>().trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    values.sort_by_key(|value| value.to_lowercase());
    values.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    (!values.is_empty()).then(|| values.join("|"))
}

#[cfg(windows)]
fn windows_version() -> Option<String> {
    use wmi::{COMLibrary, WMIConnection};

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct OperatingSystem {
        caption: Option<String>,
        version: Option<String>,
    }
    let com = COMLibrary::new().ok()?;
    let connection = WMIConnection::new(com).ok()?;
    let rows: Vec<OperatingSystem> = connection
        .raw_query("SELECT Caption, Version FROM Win32_OperatingSystem")
        .ok()?;
    stable_values(rows.into_iter().flat_map(|row| [row.caption, row.version]))
}

#[cfg(not(windows))]
fn windows_version() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vector() -> Value {
        serde_json::from_str(include_str!("../test-data/offline-license-v1.json")).unwrap()
    }

    fn vector_fingerprint(vector: &Value) -> DeviceFingerprint {
        DeviceFingerprint {
            fingerprint_version: 1,
            components: serde_json::from_value(vector["componentHashes"].clone()).unwrap(),
        }
    }

    #[test]
    fn hashes_public_fingerprint_vector_exactly() {
        let vector = vector();
        for name in COMPONENT_NAMES {
            let raw = vector["rawInputs"][name].as_str().unwrap();
            assert_eq!(
                hash_component(name, raw).unwrap(),
                vector["componentHashes"][name]
            );
        }
    }

    #[test]
    fn verifies_the_public_rxw_receipt_vector() {
        let vector = vector();
        verify_receipt(
            &vector["receipt"],
            &vector_fingerprint(&vector),
            vector["publicKeyPem"].as_str().unwrap(),
            "desktop-app",
            Some("rxw-test-vector-2026-01"),
        )
        .unwrap();
    }

    #[test]
    fn rejects_a_tampered_receipt() {
        let mut vector = vector();
        vector["receipt"]["payload"]["activationId"] = json!("altered");
        assert!(matches!(
            verify_receipt(
                &vector["receipt"],
                &vector_fingerprint(&vector),
                vector["publicKeyPem"].as_str().unwrap(),
                "desktop-app",
                Some("rxw-test-vector-2026-01"),
            ),
            Err(LicenseFailure::Invalid)
        ));
    }

    #[test]
    fn rejects_a_receipt_for_another_application() {
        let vector = vector();
        assert!(matches!(
            verify_receipt(
                &vector["receipt"],
                &vector_fingerprint(&vector),
                vector["publicKeyPem"].as_str().unwrap(),
                APP_ID,
                Some("rxw-test-vector-2026-01"),
            ),
            Err(LicenseFailure::WrongApp)
        ));
    }

    #[test]
    fn accepts_a_storage_change_but_rejects_a_different_machine() {
        let vector = vector();
        let mut changed_storage = vector_fingerprint(&vector);
        changed_storage
            .components
            .insert("storage".into(), "0".repeat(64));
        verify_receipt(
            &vector["receipt"],
            &changed_storage,
            vector["publicKeyPem"].as_str().unwrap(),
            "desktop-app",
            Some("rxw-test-vector-2026-01"),
        )
        .unwrap();

        let mut other_machine = vector_fingerprint(&vector);
        other_machine
            .components
            .insert("motherboard".into(), "0".repeat(64));
        other_machine
            .components
            .insert("cpu".into(), "1".repeat(64));
        assert!(matches!(
            verify_receipt(
                &vector["receipt"],
                &other_machine,
                vector["publicKeyPem"].as_str().unwrap(),
                "desktop-app",
                Some("rxw-test-vector-2026-01"),
            ),
            Err(LicenseFailure::WrongDevice)
        ));
    }

    #[test]
    fn development_build_is_compiled_without_a_license_gate() {
        #[cfg(not(feature = "commercial"))]
        assert_eq!(development_state().edition, "development");
    }

    #[test]
    fn normalizes_accidental_license_whitespace() {
        assert_eq!(
            normalize_license_key("  22222- 22222\n-22222-22222  "),
            "22222-22222-22222-22222"
        );
    }

    #[test]
    fn embedded_production_public_key_is_valid_ed25519_spki() {
        verifying_key_from_pem(PRODUCTION_PUBLIC_KEY).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn atomically_replaces_only_the_completed_receipt_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("license.rxw");
        let temporary = directory.path().join("license.tmp");
        fs::write(&target, b"anterior").unwrap();
        fs::write(&temporary, b"completo").unwrap();

        replace_complete_file(&temporary, &target).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"completo");
        assert!(!temporary.exists());
    }

    #[cfg(windows)]
    #[test]
    fn collects_only_the_five_hashed_windows_components() {
        let fingerprint = collect_device_fingerprint().unwrap();
        assert_eq!(fingerprint.fingerprint_version, 1);
        assert_eq!(fingerprint.components.len(), COMPONENT_NAMES.len());
        for name in COMPONENT_NAMES {
            assert!(is_sha256_hex(fingerprint.components.get(name).unwrap()));
        }
    }
}
