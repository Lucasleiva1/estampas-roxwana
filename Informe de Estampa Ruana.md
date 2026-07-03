# Informe de Estampa Ruana

Fecha: 2026-07-03

## Resumen corto

La aplicacion actual es una app de escritorio hecha con Tauri v2, React, TypeScript y SQLite local. La idea base esta armada, pero el resultado no esta bien terminado para el uso real que se necesita: abrir carpetas rapido, navegar imagenes sin trabas y clasificar estampas con una interfaz clara.

El problema principal no es que falten tecnologias, sino que varias decisiones de implementacion quedaron mal para el flujo real:

- El boton superior "Abrir carpeta" no abre la carpeta de la estampa seleccionada: abre el selector para elegir otra biblioteca.
- El boton que intenta abrir la carpeta real esta en la barra inferior y puede quedar visualmente escondido o mal ubicado.
- Si abrir carpeta falla, no hay mensaje claro porque la llamada no tiene manejo de errores en la UI.
- La app escanea toda la biblioteca al iniciar y tambien ante cambios; no hay escaneo incremental real.
- El watcher de archivos llama a un reescaneo completo porque `rescan_paths` ignora los paths recibidos.
- Las miniaturas no estan resueltas de forma robusta: si no hay thumbnail cacheado, algunas zonas pueden intentar mostrar imagenes grandes como si fueran miniaturas.
- La interfaz fue hecha por iteraciones rapidas y quedo inconsistente: botones apretados, textos que se pisan, zonas que no priorizan el flujo principal.

En criollo: la app tiene una base tecnica, pero todavia no esta pensada como herramienta diaria confiable.

## Ubicaciones importantes

Proyecto:

`C:\Users\jaell\Desktop\PAGINAS WEB Y APP\estampas-roxwana`

Biblioteca de estampas usada por defecto:

`C:\Users\jaell\Documents\estampas-roxwana`

Base SQLite local:

`C:\Users\jaell\AppData\Local\com.roxwana.biblioteca-visual\roxwana-biblioteca.sqlite`

Cache de miniaturas:

`C:\Users\jaell\AppData\Local\com.roxwana.biblioteca-visual\thumbnails`

Ejecutable debug:

`C:\Users\jaell\Desktop\PAGINAS WEB Y APP\estampas-roxwana\src-tauri\target\debug\roxwana-biblioteca-visual.exe`

Archivos clave:

- `package.json`
- `src\App.tsx`
- `src\styles.css`
- `src\lib\api.ts`
- `src\lib\filtering.ts`
- `src-tauri\src\main.rs`
- `src-tauri\capabilities\default.json`
- `src-tauri\tauri.conf.json`

## Stack actual

Frontend:

- React 18
- TypeScript
- Vite
- Lucide icons
- `@tanstack/react-virtual` para virtualizar la lista lateral
- Tauri JS APIs y plugins

Backend:

- Tauri v2
- Rust
- SQLite con `rusqlite`
- Escaneo recursivo con `walkdir`
- Procesamiento de imagenes con crate `image`
- Hashes con `sha2`

Plugins Tauri:

- `tauri-plugin-dialog`
- `tauri-plugin-fs`
- `tauri-plugin-opener`
- `tauri-plugin-persisted-scope`
- `tauri-plugin-sql`

## Como funciona el escaneo

El comando principal es `scan_library` en `src-tauri\src\main.rs`.

Flujo:

1. Recibe una carpeta raiz.
2. Recorre recursivamente con `WalkDir`.
3. Solo considera extensiones soportadas.
4. Agrupa archivos por carpeta.
5. Si hay imagenes sueltas en la raiz, las trata como disenios individuales.
6. Detecta preview principal entre `.jpg`, `.jpeg`, `.png`, `.webp`.
7. Detecta soportes `.ai`, `.psd`, `.svg`, `.pdf`, `.eps`, `.zip`, `.txt`.
8. Genera una clasificacion automatica por nombre de carpeta/archivo.
9. Guarda o actualiza todo en SQLite.
10. Devuelve todos los disenios completos al frontend.

Problema:

El escaneo es completo cada vez. Incluso `rescan_paths`, que supuestamente deberia reescanear solo paths modificados, actualmente ignora la lista de paths:

```rust
fn rescan_paths(app: AppHandle, root_path: String, paths: Vec<String>) -> Result<LibraryResponse, String> {
    let _ = paths;
    scan_library_impl(&app, &root_path)
}
```

Eso significa que cualquier cambio detectado por el watcher dispara otro escaneo completo.

## Como funciona la base SQLite

Tablas principales:

- `settings`: guarda configuracion como la carpeta raiz.
- `designs`: guarda cada estampa o carpeta de estampa.
- `files`: guarda archivos detectados por diseno.
- `categories`: categorias.
- `tags`: etiquetas.
- `design_tags`: relacion entre estampas y etiquetas.
- `ignored_auto_tags`: etiquetas automaticas que el usuario borro.

Estados soportados:

- `pending`
- `working`
- `ready`
- `discarded`

La clasificacion automatica esta en Rust dentro de `classify_design`. Usa reglas simples por palabras: skull/calavera, skate, surf, woman, man, rock, urban, etc.

## Como funciona la interfaz actual

El archivo principal es `src\App.tsx`.

Estructura visual:

- Header superior con logo ROXWANA, filtros rapidos y botones.
- Panel izquierdo con filtros.
- Centro con imagen grande.
- Panel derecho con lista virtualizada de estampas.
- Barra inferior con archivo seleccionado, contadores, estado, categoria, etiquetas y boton para abrir carpeta.

El panel derecho fue corregido para usar virtualizacion. Eso reduce mucho el bloqueo por renderizar cientos de tarjetas a la vez.

## Problema especifico: abrir carpetas

Este es el punto mas importante y esta mal resuelto.

Actualmente hay dos comportamientos distintos con texto parecido:

1. En el header, el boton dice "Abrir carpeta", pero llama a `chooseFolder`.
2. `chooseFolder` abre un dialogo para elegir la carpeta raiz de biblioteca.
3. En la barra inferior, otro boton "Abrir carpeta" llama a `openPath(design.directory)`.

O sea: el boton mas visible no abre la carpeta de la estampa. Cambia o elige la biblioteca. Eso es una mala decision de UX.

Codigo relacionado:

```tsx
<button className="action-button" onClick={onChooseFolder}>
  <FolderOpen />
  <span>Abrir carpeta</span>
</button>
```

Ese boton deberia llamarse "Elegir biblioteca" o "Cambiar carpeta raiz", no "Abrir carpeta".

El boton real:

```tsx
<button className="tray-action" onClick={() => onOpenPath(design.directory)}>
  <FolderOpen />
  Abrir carpeta
</button>
```

`onOpenPath` viene de:

```tsx
import { openPath } from "@tauri-apps/plugin-opener";
```

Problemas de esa implementacion:

- No tiene `try/catch`.
- Si falla por permisos, path, plugin o Windows, el usuario no ve nada.
- No usa `revealItemInDir`, que probablemente seria mejor para seleccionar el archivo dentro de la carpeta.
- No existe un comando Rust propio tipo `open_design_folder` que use `explorer.exe` directamente.
- No hay tests ni logs para esta accion.

Permisos declarados:

```json
"opener:default",
"opener:allow-open-path"
```

Eso parece correcto para `openPath`, pero si se cambia a `revealItemInDir`, hay que agregar tambien:

```json
"opener:allow-reveal-item-in-dir"
```

## Recomendacion concreta para arreglar abrir carpetas

No depender del boton inferior ni de `openPath` suelto desde React. Implementar comandos Rust claros:

- `open_design_folder(path: String)`
- `reveal_design_file(path: String)`

En Windows, `open_design_folder` deberia hacer algo equivalente a:

```rust
std::process::Command::new("explorer")
    .arg(path)
    .spawn()
```

Y para revelar archivo:

```rust
std::process::Command::new("explorer")
    .arg(format!("/select,{}", path))
    .spawn()
```

Despues, desde React:

```ts
await invoke("open_design_folder", { path: design.directory })
```

Con `try/catch` y mensaje visible si falla.

Tambien cambiar textos:

- Boton superior: "Elegir biblioteca"
- Boton de estampa: "Abrir carpeta de esta estampa"
- Accion secundaria: "Mostrar archivo"

## Problemas de rendimiento actuales o historicos

1. Escaneo completo en cada arranque

`get_initial_state` llama a `scan_library_impl`. Eso significa que iniciar la app no solo carga la DB, sino que recorre otra vez la carpeta real.

Mejor:

- Al iniciar, cargar primero desde SQLite.
- Mostrar la app rapido.
- Escanear en segundo plano.
- Actualizar diferencias.

2. Watcher no incremental

El watcher escucha cambios, pero reescanea todo. Esto puede trabar cuando se copian muchos archivos.

Mejor:

- Usar los paths recibidos.
- Debounce mas largo para copias masivas.
- Reescanear solo carpetas afectadas.

3. Imagen grande en el visor

El visor central muestra el archivo original con `convertFileSrc`. Si el JPG pesa 10 MB o mas, el WebView puede trabarse al cambiar rapido.

Mejor:

- Generar preview optimizado para visor, por ejemplo 1600 px max.
- Usar el original solo al abrir archivo externo.
- Precargar solo anterior/siguiente.

4. Miniaturas

Se intento generar thumbnails, pero el flujo quedo inconsistente. En algunas versiones generaba demasiado; en la actual no genera automaticamente, pero si no hay cache puede usar imagen original en el lateral.

Mejor:

- Crear thumbnails en backend durante escaneo incremental, pero con cola limitada.
- No bloquear UI.
- No mostrar originales como thumbnails.
- Usar placeholders hasta que el thumbnail exista.

5. Datos enormes enviados al frontend

`scan_library` devuelve todos los disenios con todos sus archivos. Para 1000 archivos no es mortal, pero no escala bien.

Mejor:

- API paginada o resumida para grilla/lista.
- Detalle completo solo al seleccionar un diseno.

## Problemas de UI actuales

- La interfaz intenta imitar un mockup visual, pero todavia no esta bien adaptada a ventanas reales.
- La barra inferior puede quedar apretada.
- Hay demasiadas acciones con nombres ambiguos.
- Los filtros rapidos tienen contadores falsos o poco utiles en algunos casos.
- Las categorias automaticas son basicas y pueden clasificar mal.
- El flujo principal deberia ser: seleccionar estampa -> verla -> abrir carpeta -> clasificar. Hoy ese flujo no esta suficientemente claro.

## Lo que si existe y se puede aprovechar

- Base Tauri/React ya creada.
- Escaneo recursivo funcional.
- SQLite local funcional.
- Agrupacion por carpetas.
- Deteccion de archivos de soporte.
- Estados, favoritos, categorias y etiquetas persistentes.
- Clasificacion automatica inicial editable.
- Lista lateral virtualizada.
- Build de Tauri funcionando.

## Lo que hay que rehacer prioritariamente

1. Abrir carpetas

Implementar comando Rust propio y dejarlo como accion principal visible.

2. Arranque rapido

No escanear todo al iniciar. Cargar SQLite primero.

3. Watcher incremental

No hacer full rescan ante cada cambio.

4. Previews y thumbnails bien hechos

Crear cache de previews chicas y usar eso en UI.

5. UI mas simple

Antes de hacerla linda, hacerla usable:

- visor grande;
- lista simple;
- boton grande "Abrir carpeta";
- boton "Mostrar archivo";
- categoria;
- tags;
- favorito;
- estado.

6. Manejo de errores

Cada accion importante debe avisar si fallo.

## Pedido recomendado para otro ChatGPT o desarrollador

Copiar este pedido:

> Tengo una app Tauri v2 + React + TypeScript + SQLite para visualizar estampas desde una carpeta local. El proyecto esta en `C:\Users\jaell\Desktop\PAGINAS WEB Y APP\estampas-roxwana`. Necesito arreglar lo mas importante: abrir la carpeta real de la estampa seleccionada. Actualmente el boton superior "Abrir carpeta" abre un dialogo para elegir biblioteca, y el boton inferior usa `openPath(design.directory)` desde `@tauri-apps/plugin-opener` sin manejo de errores. Quiero implementar comandos Rust `open_design_folder(path)` y `reveal_design_file(path)` usando Explorer en Windows, exponerlos con `invoke`, cambiar los textos de UI y agregar manejo de error. Despues quiero optimizar rendimiento: cargar primero SQLite sin escanear todo al iniciar, hacer watcher incremental, y usar thumbnails/previews cacheados sin cargar imagenes grandes en la lista lateral.

## Estado de validacion conocido

En la ultima iteracion se corrio:

- `npm.cmd test`
- `cargo test`
- `npm.cmd run tauri build -- --debug`

Eso compila, pero compilar no significa que el producto este bien. El problema real es de flujo, UX, apertura de carpetas y rendimiento percibido.

## Conclusion

La app tiene cimientos, pero no esta lista para uso diario. El error mas grave es que la accion principal del usuario, abrir carpetas de estampas, esta mal ubicada, mal nombrada y mal implementada. La segunda falla es que el rendimiento se fue complicando por escaneos completos, imagenes grandes y cache de miniaturas sin una estrategia clara.

La solucion no es agregar mas cosas. Hay que simplificar y asegurar el flujo basico:

1. abrir rapido;
2. mostrar imagen;
3. abrir carpeta real;
4. clasificar;
5. detectar nuevos archivos sin trabarse.

