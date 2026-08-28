# Reglas obligatorias de las carpetas de ROXWANA

Este archivo define el comportamiento funcional de las carpetas de la biblioteca visual. Es una especificación del producto y debe leerse antes de modificar el escáner, la agrupación, las categorías, Referencias o Trabajos.

La implementación guardada en el Release de GitHub `app-v0.1.9` es la referencia del comportamiento correcto de la Biblioteca. Las funciones nuevas de Referencias deben agregarse sin cambiar ese comportamiento.

## Regla principal de Trabajos

`Trabajos` funciona como un contenedor de categorías físicas.

- Cada carpeta directamente dentro de `Trabajos` representa una categoría con el nombre de esa carpeta.
- Ejemplo: `Trabajos\Che Guevara` crea la categoría visible `Che Guevara`.
- Al seleccionar `Che Guevara`, la aplicación debe mostrar por separado todos los archivos o elementos que contiene esa carpeta.
- Si hay nueve imágenes directamente dentro de `Trabajos\Che Guevara`, la categoría debe mostrar nueve elementos; nunca una única tarjeta que represente toda la carpeta.
- Los archivos agregados posteriormente por el usuario —PNG, JPG, WEBP, PSD, AI, SVG, PDF u otros formatos compatibles— deben aparecer al volver a escanear, conservando el comportamiento normal de la Biblioteca.
- La carpeta de un trabajo no debe convertirse en una única unidad visual ni colapsar todo su contenido en un solo diseño.
- No crear subestructuras automáticas dentro del trabajo. El usuario decide qué otros archivos o carpetas agrega después.

### Flujo Referencias → Trabajos

Cuando el usuario envía una referencia a un trabajo:

1. Crear, si no existe, `Trabajos\<nombre del trabajo>`.
2. Copiar la imagen de referencia dentro de esa carpeta.
3. No mover, borrar ni modificar la referencia original.
4. Hacer que `<nombre del trabajo>` aparezca como categoría de Trabajos.
5. Mostrar la imagen copiada como un elemento dentro de esa categoría.
6. Si el usuario agrega más archivos después, mostrarlos también como elementos de la misma categoría.

Ejemplo:

```text
Referencias\Personajes\capitan-america.png
                    │ copiar
                    ▼
Trabajos\Capitán América\capitan-america.png
```

El resultado visible es la categoría `Capitán América`, y dentro aparece `capitan-america.png` junto con cualquier PNG, PSD, AI u otro archivo que el usuario agregue posteriormente.

## Categorías

- Cada carpeta directamente dentro de `Categorías` representa una categoría con su propio nombre.
- Al seleccionar una categoría, se muestra el contenido que corresponde a esa carpeta según el comportamiento existente de la Biblioteca.
- No colapsar toda la carpeta de categoría en una sola tarjeta.
- La clasificación manual y los metadatos guardados deben conservarse durante los reescaneos.

## Freepik

- `Freepik` conserva el comportamiento simple existente de la Biblioteca.
- La aplicación muestra las carpetas o elementos de Freepik y, al abrir uno, muestra todo su contenido.
- No agregar automatismos de clasificación, conversión o reorganización que no hayan sido pedidos.
- No cambiar su forma de agrupación como efecto secundario de Referencias o Trabajos.

## Suelta

- `Suelta` es una carpeta común para contenido que el usuario incorpora libremente.
- Al agregar una carpeta, la aplicación permite ver las imágenes o archivos que contiene.
- Si el usuario cataloga un elemento, la catalogación debe persistir.
- Si no lo cataloga, debe permanecer sin catalogar; no asignar categorías automáticamente por una función nueva.
- No cambiar su comportamiento como efecto secundario de Referencias o Trabajos.

## Referencias

- `Referencias` es una sección separada de la Biblioteca.
- Las carpetas directamente dentro de `Referencias` funcionan como categorías de referencias.
- Al abrir una categoría se muestran las imágenes que contiene.
- Una referencia puede tener estado, favorito y conexión con un trabajo sin alterar la agrupación de la Biblioteca.
- Reescanear Referencias debe afectar solamente el índice de Referencias.
- Agregar o modificar Referencias no autoriza a cambiar el escáner general de la Biblioteca, ni la lógica de `Categorías`, `Freepik`, `Suelta` o `Trabajos`.
- Toda ruta que contenga `_roxwana-cache` es caché técnico: nunca debe contarse, mostrarse, categorizarse ni tratarse como una referencia.
- El vigilante de archivos de Referencias debe ignorar los eventos originados exclusivamente dentro de `_roxwana-cache`.

## Error que no debe repetirse

El 24 de agosto de 2026 se introdujo por error una lógica equivalente a `physical_content_unit` que trataba la primera carpeta de `Freepik`, `Suelta` y `Trabajos` como una única unidad visual. Además, se forzó un reescaneo general mediante una versión de estructura.

Ese cambio hizo que `Trabajos\Che Guevara`, que debía actuar como una categoría con todos sus elementos visibles, apareciera como un único trabajo o una única tarjeta. Esto contradice directamente el comportamiento requerido y el Release `app-v0.1.9`.

Está prohibido volver a implementar esa agrupación.

También el 24 de agosto de 2026, el escáner de Referencias recorrió por error `_roxwana-cache`. Cada miniatura fue tomada como una referencia nueva y produjo otra miniatura, creando caché dentro de caché, aumentando el contador continuamente y haciendo saltar las imágenes. Todo escáner presente o futuro debe excluir el árbol `_roxwana-cache` antes de recorrer sus archivos.

En particular:

- No agrupar todos los archivos de `Trabajos\<nombre>` bajo un solo identificador de diseño.
- No usar la carpeta `Trabajos\<nombre>` como `key_path` común para todos sus archivos directos.
- No incorporar `Trabajos` a una función genérica que trate carpetas como unidades visuales únicas.
- No forzar un reescaneo general de la Biblioteca para implementar o actualizar Referencias.
- No modificar la lógica de agrupación existente sin comparar primero con `app-v0.1.9` y obtener aprobación explícita del usuario.

## Verificación obligatoria para cambios futuros

Todo cambio que toque el escáner o el flujo Referencias → Trabajos debe comprobar como mínimo este caso:

```text
Trabajos\Che Guevara\imagen-1.png
Trabajos\Che Guevara\imagen-2.png
Trabajos\Che Guevara\archivo.psd
```

Resultado obligatorio:

- Existe la categoría `Che Guevara`.
- Al abrirla aparecen tres elementos separados.
- No aparece una única tarjeta llamada `Che Guevara` que contenga los tres archivos.
- La referencia original, si alguna imagen llegó desde Referencias, continúa intacta en su ubicación original.

Antes de entregar el cambio, ejecutar las pruebas del escáner y verificar en la aplicación nativa una categoría real de Trabajos con más de un elemento.

## Permisos de la carpeta elegida y vigilante de archivos

La aplicación se instala en PCs que no son la de desarrollo. Antes de adoptar una carpeta como biblioteca hay que comprobar contra el disco real, no suponer.

### Comprobación obligatoria antes de aceptar una carpeta

`check_library_folder` corre siempre antes de escanear, y `get_initial_state` repite la parte de permisos sobre la carpeta ya guardada. La comprobación incluye, en este orden:

1. Que exista y sea una carpeta.
2. Que no sea una carpeta del sistema: raíz del disco de Windows, `%SystemRoot%`, Archivos de programa, `%ProgramData%`, `%LOCALAPPDATA%`, `%APPDATA%`, el perfil de usuario completo, `C:\Users` o la carpeta donde está instalada la aplicación. Este rechazo se aplica solo al elegir una carpeta nueva: una biblioteca que ya venía funcionando no se le quita al usuario.
3. Que se pueda leer (`read_dir`).
4. Que se pueda crear un archivo suelto en la raíz, como hace la copia de `Preferences`.
5. Que se pueda crear una subcarpeta con un archivo adentro, como hace `_roxwana-cache` al lado de cada imagen. El Acceso controlado a carpetas de Windows puede permitir una cosa y bloquear la otra.

Los archivos de prueba se borran siempre y nunca reemplazan contenido del usuario.

### Mensajes de error

Todo fallo de disco se traduce con `describe_root_failure`, que convierte el código de Windows en una instrucción concreta: Acceso controlado a carpetas, pendrive con la pestaña de bloqueo, unidad no conectada, disco lleno, ruta demasiado larga o archivo en uso. Está prohibido devolverle al usuario el error crudo de Windows sin explicar qué tiene que hacer.

`ensure_starter_directories` además comprueba que la carpeta haya quedado realmente en el disco después de crearla: un antivirus puede aceptar la orden y revertirla.

### Avisos que no bloquean

`library_root_warnings` devuelve avisos para carpetas de red, carpetas dentro de OneDrive, rutas muy largas y unidades enteras. Se muestran en un cartel de confirmación antes de escanear. No impiden usar la carpeta.

### El vigilante nunca puede dejar la biblioteca congelada

El aviso instantáneo de Windows no funciona en todos lados. Reglas:

- Al elegir una carpeta se prueba el vigilante de verdad sobre ella y, si no arranca, se avisa antes de escanear.
- Si `watch` falla, la Biblioteca y Referencias pasan a comprobar los cambios cada minuto y cada vez que la ventana vuelve al foco, con un mínimo de 15 segundos entre pasadas. Ese respaldo recorre el árbol, así que no debe correr cuando el vigilante funciona.
- La falla del vigilante se muestra como aviso ámbar, no como error rojo: la aplicación sigue funcionando.

### Red de seguridad de la base

`Preferences` sigue siendo la fuente de verdad, pero antes de descartar o reemplazar la base local se guarda una copia de rescate en `copias-de-seguridad`. Nunca se descarta la clasificación del usuario sin dejar una copia.
