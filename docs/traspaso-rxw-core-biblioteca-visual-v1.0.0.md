# Traspaso para registrar Biblioteca Visual en RXW Core

**Versión del documento:** 1.0.0  
**Fecha:** 2026-09-14  
**Aplicación cliente:** Biblioteca Visual 0.1.21  
**Objetivo:** registrar la aplicación en RXW Core, generar una licencia de prueba habilitada y comprobar que la edición comercial puede activarse.

## Pedido para el asistente que trabaje en RXW Core

Estoy trabajando ahora en el proyecto **RXW Core**, el programa que administra y genera licencias. Necesito registrar **Biblioteca Visual** como aplicación licenciable y generar una clave de prueba que pueda activarse desde su edición comercial.

Antes de modificar datos o código, verificá la identidad de RXW Core:

- Proyecto esperado: `rxw-core`
- Ruta esperada: `D:\PAGINAS WEB Y APP\rxw-core`
- Remoto esperado: `https://github.com/Lucasleiva1/rxw-core.git`
- Confirmá también la rama, la identidad del producto y el entorno de producción correspondiente.

No modifiques el proyecto Biblioteca Visual para resolver este pedido. Su integración cliente ya está terminada.

## Registro exacto de la aplicación

Crear o confirmar en el panel de producción de RXW Core el siguiente registro:

```text
appId: biblioteca-visual
Nombre visible: Biblioteca Visual
Estado: ACTIVE / enabled = true
Notas sugeridas: Edición comercial de Biblioteca Visual
```

El `appId` es un contrato estable y debe ser exactamente `biblioteca-visual`, en minúsculas y con guion. No usar `biblioteca_visual`, `estampas-roxwana`, `roxwana-biblioteca-visual` ni otro identificador.

Si el registro ya existe, no crear un duplicado. Verificar que esté habilitado y que el nombre visible sea correcto.

## Datos que ya usa Biblioteca Visual

```text
appId compilado: biblioteca-visual
Endpoint de activación: https://rxw-core.netlify.app/api/licenses/activate
Protocolo: 2
Tipo de licencia esperado: PERPETUAL
fingerprintVersion: 2
Algoritmo de firma: Ed25519
keyId esperado: rxw-signing-prod-2026-01
Versión actual de la aplicación: 0.1.21
Identificador Tauri: com.roxwana.biblioteca-visual
```

Biblioteca Visual ya contiene únicamente la clave pública de producción. No copiar, reemplazar ni exponer claves privadas para completar este registro.

## Generar una licencia de prueba

Después de confirmar la aplicación:

1. Abrir **Licencias** en RXW Core.
2. En **Crear una licencia**, seleccionar `Biblioteca Visual · biblioteca-visual`.
3. Elegir **Una licencia**.
4. Pulsar **Generar licencia**.
5. Pulsar **Guardar esta licencia**.
6. Confirmar que la licencia aparece inicialmente como `AVAILABLE`.
7. Pulsar **Habilitar** o ejecutar la acción administrativa equivalente a `MARK_SOLD`.
8. Completar como mínimo una referencia de venta, pedido o email. Para una prueba puede usarse una referencia inequívoca como `PRUEBA-BIBLIOTECA-VISUAL-001`.
9. Confirmar que el estado final previo a la activación sea `SOLD`.
10. Entregar al usuario solamente la clave de licencia generada.

Una licencia `AVAILABLE` todavía no debe activar la aplicación; debe estar `SOLD` antes de usarla.

## Prueba integral esperada

1. Abrir la edición comercial de Biblioteca Visual 0.1.21.
2. Pegar la licencia `SOLD` y pulsar **Activar aplicación**.
3. Confirmar que RXW Core acepta `appId = biblioteca-visual` y deja de responder `INVALID_APP`.
4. Confirmar que la licencia pasa a `ACTIVATED`.
5. Confirmar que RXW Core emite un receipt firmado válido para esa aplicación.
6. Cerrar y volver a abrir Biblioteca Visual para verificar el acceso con el comprobante local.
7. Si es posible, comprobar una apertura sin conexión después de la primera activación.

No usar la misma licencia de prueba en otra computadora salvo que primero se libere el dispositivo desde RXW Core.

## Resultado que debe informarse

Al terminar, indicar claramente:

- si `biblioteca-visual` fue creada o ya existía;
- si quedó habilitada;
- la clave de prueba generada y su estado, únicamente en la conversación privada con el usuario;
- si la activación real terminó correctamente;
- el estado final de la licencia;
- cualquier error concreto que impida completar la prueba.

## Seguridad y límites

- No mostrar, copiar, registrar ni guardar en GitHub la clave privada Ed25519 de producción.
- No revelar secretos de Netlify, credenciales administrativas, cookies, tokens ni contraseñas.
- Si hace falta iniciar sesión, pedir al usuario que lo haga directamente.
- No cambiar el `appId`, el endpoint, la clave pública o la política de hardware sin verificar primero el contrato de Biblioteca Visual.
- No crear productos de tienda ni modificar precios para esta prueba; la generación administrativa manual de licencias no lo necesita.
- No publicar, confirmar ni desplegar cambios de código de RXW Core salvo que el usuario lo autorice expresamente.

## Referencia del cliente integrado

La integración de Biblioteca Visual está guardada en:

```text
Repositorio: https://github.com/Lucasleiva1/estampas-roxwana.git
Commit estable: d0be1d3
Etiqueta: app-v0.1.21
```

El error observado antes de registrar la aplicación fue:

```text
INVALID_APP: La aplicación no está registrada o no está habilitada.
```

El registro correcto de `biblioteca-visual` en producción debe resolver específicamente ese error.
