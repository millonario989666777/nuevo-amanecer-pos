# Comprobantes para compartir sin API de WhatsApp

Después del guardado duradero de una venta, crédito o abono se ofrece compartir o cancelar. Cancelar y volver a compartir son acciones de presentación: no crean ventas, movimientos ni pagos. Las ventas pendientes del outbox se identifican como guardadas localmente, pendientes de sincronización.

Configuración → Ticket permite elegir imagen PNG, texto o PDF y activar/desactivar la pregunta al finalizar. La preferencia usa la configuración persistente existente. El formulario también permite cambiar el formato para un comprobante concreto.

Texto es el formato predeterminado y permite enviar con un solo clic (o Enter en el campo de número): abre `wa.me` con el número del cliente y un mensaje prellenado con saludo ("Hola <cliente>, gracias por tu compra.") y el ticket en monoespaciado; si falta el número, el foco va al campo de número y no se abre nada hasta que sea válido. Las preferencias ya guardadas (por ejemplo imagen) se respetan. **Enviar desde (solo Android, solo texto):** el formulario y Configuración → Ticket ofrecen «Automático (wa.me)» (predeterminado, comportamiento anterior), «WhatsApp» y «WhatsApp Business». Se guarda en la configuración del ticket como `ticket.shareApp` (`auto`|`whatsapp`|`business`; ausente = `auto`, sin migración). En Android con una app elegida se abre `intent://send?phone=<dígitos>&text=<mensaje codificado>#Intent;scheme=whatsapp;package=com.whatsapp|com.whatsapp.w4b;S.browser_fallback_url=<wa.me codificado>;end`, que vuelve a `wa.me` si la app no está instalada. En iOS y escritorio el selector queda deshabilitado con una nota y siempre se usa `wa.me`. Imagen y PDF no cambian: siguen usando el menú de compartir del dispositivo (donde se elige la app y el contacto) o la descarga. Helpers puros en `NAReceiptShare`: `isAndroid`, `intentUrl`, `sendUrl`.

Imagen/PDF generan un archivo real y usan el menú de compartir del dispositivo: el usuario debe elegir WhatsApp/contacto y confirmar. Un navegador sin compartir archivos ofrece descarga. Abrir o compartir nunca se registra como entrega confirmada. No hay envío automático ni API de WhatsApp.

El contenido reutiliza `_naBuildThermalTicket` con los ajustes guardados: zonas, orden, alineación, ancho y productos/precios de la operación. La rasterización utiliza Courier; no replica todos los estilos tipográficos del editor. PDF divide tickets largos en páginas sin cortar líneas. Los abonos identifican la compra original y los saldos de ese pago. Si un dato histórico no existe, se muestra “No registrado”. El reenvío de una venta a crédito resuelve su crédito relacionado para mostrar el saldo actual.

Clientes → Datos del cliente permite guardar nombre y WhatsApp. En CANON esto usa `customer.contact.set`, con revisión esperada, idempotencia, autoridad y registro inmutable separado. Una edición concurrente obsoleta se rechaza. Una respuesta perdida reintenta el mismo payload; una edición pendiente de otro cliente no se confirma como propia. Las versiones de contacto se incorporan a la lectura bajo la misma cerca de revisión del snapshot. Los registros financieros originales no cambian.

## Activación y compatibilidad

1. Candidato y revisión: rama aislada desde CANON, Draft PR, CANON Critical CI, E2E y revisión independiente.
2. Con autorización vigente del propietario para la implementación completa, aplicar `0020_canonical_customer_contacts.sql` sobre el esquema CANON existente (prerrequisitos 0014–0018). Es aditiva y no cambia registros financieros. Conservar backup y evidencia del destino antes de ejecutarla.
3. Desplegar el Worker del mismo candidato y comprobar lectura/contactos. Sin 0020 el Worker conserva lecturas existentes y rechaza las ediciones nuevas con 503 `customer_contact_schema_not_ready`.
4. Publicar el POS del mismo SHA. Verificar ajustes, cliente, venta y abono en datos aislados; confirmar recepción manual en WhatsApp con una prueba autorizada.

El despliegue web y el hotfix de Worker existentes no aplican esta migración. No ejecutar una publicación web sola como activación completa. El rollback de aplicación puede volver al SHA anterior conservando la tabla aditiva y sus contactos; nunca eliminar las versiones guardadas para revertir la interfaz.

## Evidencia local

- Regresión relevante: 787/787 antes del último test adicional de captura; pruebas focalizadas finales: 52/52.
- Contratos de arquitectura y backend: 54/54.
- Navegador: 16/16; 320, 360, 390, 430, 768, 1024, 1366 y 1920 px, cancelar sin mutar, archivos PNG/PDF, destino del texto, reenvío de crédito, recuperación de contactos y configuración tras recarga.
- Suite completa de navegador: 140/147; los siete fallos (medidas de tarjetas de pago y botones de venta) se reprodujeron exactamente en la base `451c5b6`, 7/8 en el barrido focalizado de esa base. No se alteraron sus assertions.
- Todas las migraciones, incluida 0020, aplicadas en D1 local aislado: PASS. Snapshot SQL: PASS. PDF real validado y renderizado con Poppler: PASS.
- Build Worker producción: `wrangler deploy --dry-run` PASS.
- Barrido ampliado inicial: 869/874; los cinco fallos se reprodujeron en la base `451c5b6` (contratos estructurales anteriores de menú, proyección operativa y stock). No se modificaron esas expectativas.
- Reviewer/Forensic independiente: sin P0/P1 abiertos tras corregir los hallazgos.

Las pruebas de compartir usan un adaptador de navegador y no envían mensajes reales. La elección y confirmación en la aplicación WhatsApp siguen siendo acciones del usuario.

## Estado de publicación

El candidato permanece en la rama local `feature/canon-whatsapp-receipts`. La revisión automática rechazó el push a `quijanopomae-crypto/nuevo-amanecer-pos` por falta de autorización explícita para exportar el código y la migración a ese destino. No se creó PR ni se ejecutó CI remota, merge, deploy o migración remota. Es necesario autorizar esa publicación para continuar los gates de CANON.

## Activación autorizada

El propietario autorizó la implementación completa en CANON y reiteró que no se pidan permisos repetidos dentro del mismo alcance. PR #502 integrado en `4ecf6fc272a48c57dbed368ff9207a278b2cad8f`, con CANON Critical CI y E2E Smoke CI verdes (147/147). La autorización anterior supera las notas históricas de bloqueo/publicación.

`canon-whatsapp-receipts-activation.yml` ejecuta en orden respaldo lógico consistente de Turso cifrado con AES-256-GCM y la credencial Turso existente (clave derivada con contexto propio), almacenamiento privado R2 y comparación SHA-256, migración 0020 atómica/aditiva, verificación exacta de los 17 objetos y de integridad, deploy del Worker Turso, deploy del POS y comparación de assets públicos. El proceso no modifica saldos ni genera ventas, cobros o mensajes de WhatsApp. Si falla un paso, no se declara activo; se conserva el respaldo y se corrige o revierte el código sin eliminar contactos. El esquema aditivo puede permanecer con una versión previa del Worker.

Recuperación de respaldo: conservar la versión de `TURSO_PROD_AUTH_TOKEN` usada para derivar la clave del respaldo si se rota posteriormente. La derivación usa SHA-256 sobre el contexto `nuevo-amanecer-contact-backup-v1` seguido de un byte NUL y la credencial; el formato guarda IV, tag GCM y ciphertext en base64. No se expone la credencial ni se modifica.
