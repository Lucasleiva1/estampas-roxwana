# Compilaciones y licencias de Biblioteca Visual

Biblioteca Visual mantiene un único código fuente y produce dos ediciones. La
selección es una feature compilada dentro del ejecutable Rust; no existe un
interruptor, archivo `.env`, parámetro ni opción de interfaz que cambie la
edición después de compilar.

## Línea base

- Versión estable anterior a la integración: `app-v0.1.17`.
- Commit: `ac5540910dbe102554545b9d18d3acbfbbf4cbf1`.
- Identidad comercial en RXW Core: `biblioteca-visual`.

## Desarrollo privado

```powershell
npm.cmd run build:development
```

Compila sin la feature `commercial`, abre directamente, no lee comprobantes y
no llama a RXW Core para autorizar el inicio. Muestra una marca discreta
`DESARROLLO`. Sus artefactos son privados y no deben publicarse.

## Comercial

```powershell
npm.cmd run build:commercial
```

Compila con la feature `commercial`. Sin un comprobante local válido muestra
solamente la pantalla de activación. La primera activación usa el protocolo 2
contra `https://rxw-core.netlify.app/api/licenses/activate`; después valida el
comprobante Ed25519 localmente y puede abrir sin internet.

La clave pública está en
`src-tauri/keys/rxw-signing-prod-2026-01.public.pem`. Nunca debe incorporarse
una clave privada ni credenciales administrativas a este repositorio.

## Artefactos

Los scripts verifican que las versiones de `package.json`, `Cargo.toml` y
`tauri.conf.json` coincidan y copian los resultados a `artifacts/` con edición
y versión visibles. Se niegan a sobrescribir un archivo numerado existente.
Estos comandos generan instaladores locales sin el paquete firmado del updater;
la publicación de una actualización requiere la clave privada de actualización
de Tauri cargada externamente y nunca almacenada en este repositorio.

Ejemplos:

```text
Biblioteca-Visual-desarrollo-v0.1.20.exe
Biblioteca-Visual-desarrollo-v0.1.20-setup.exe
Biblioteca-Visual-comercial-v0.1.20.exe
Biblioteca-Visual-comercial-v0.1.20-setup.exe
```

Antes de publicar una versión comercial hay que confirmar en RXW Core que la
aplicación activa tiene el identificador `biblioteca-visual`, crear una licencia
para esa aplicación y habilitarla manualmente.

## Datos del usuario

La licencia se guarda como `license.rxw` dentro del directorio local de datos de
la aplicación. La biblioteca elegida, sus carpetas y todos sus archivos quedan
fuera del instalador y del desinstalador; la integración de licencias no cambia
ese comportamiento.
