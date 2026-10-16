# Contrato del asistente (prototipo aislado, rama feature/asistente-aislado)

Estado: prototipo. Apagado por defecto. No se publica ni se despliega.

## Rutas del Worker
| Ruta | Método | Roles (tabla única) | Qué hace |
|---|---|---|---|
| `/auth/assistant/chat` | POST | dueño, empleado | Conversa con DeepSeek y devuelve propuestas. Nunca escribe datos del negocio. |
| `/auth/assistant/confirm` | POST | dueño, empleado | Gasta el token de UNA propuesta (un solo uso, 5 min). Devuelve el `operation_id`. No escribe datos del negocio. |

- Las dos responden **404** si el Worker no tiene `ASSISTANT_ENABLED=1` (antes de pedir sesión).
- **No existen** rutas `/auth/assistant/tool` ni `/auth/assistant/audit`: el modelo no ejecuta herramientas y no hay ruta directa de herramientas. El registro de auditoría queda como siguiente paso (necesita migración aprobada por el dueño).
- Sesión: `authorizeSession` (Bearer). Rol del asistente = `assistantRole()`: solo es dueño con `pos_device_roles.pos_role='owner'` explícito. Sin fila, sin tabla o con error: **empleado**.

### Variables del Worker
| Variable | Uso |
|---|---|
| `ASSISTANT_ENABLED` | `1` para encender. Cualquier otro valor: 404. |
| `DEEPSEEK_API_KEY` | Secreto, solo en el Worker. Sin clave el chat responde **503 `assistant_not_configured`** («asistente no configurado»), salvo `ASSISTANT_DEMO=1`. |
| `ASSISTANT_DEMO` | `1` solo para el prototipo local y las pruebas: sin clave usa respuestas de demostración (`mode:"mock"`). Nunca en un Worker real. |
| `DEEPSEEK_BASE_URL` | Opcional. Por defecto `https://api.deepseek.com`. Para pruebas: `http://127.0.0.1:4599` (mock de Bot 2). |
| `ASSISTANT_CONFIRM_SECRET` | Secreto HMAC (16+ caracteres) para firmar tokens. Sin él, no se puede confirmar nada (503). |
| `ASSISTANT_PER_MINUTE`, `ASSISTANT_PER_DAY`, `ASSISTANT_PHOTOS_PER_MINUTE`, `ASSISTANT_PHOTOS_PER_DAY`, `ASSISTANT_MONTHLY_CHAT_CAP`, `ASSISTANT_MONTHLY_PHOTO_CAP`, `ASSISTANT_CONFIRMS_PER_MINUTE` | Límites (opcionales). |

Modelo fijo: `deepseek-flash`, `thinking: {type: "disabled"}`, `tool_choice: "auto"`, `max_tokens: 900`, tiempo máximo 25 s.

### `POST /auth/assistant/chat`
Pide: `{ "text": "...", "image": "data:image/jpeg;base64,..." (opcional), "history": [{role, content}] (máx. 8), "context": { "screen": "pagePOS", "products": [{id, nombre, precio, stock, costo?}] } }`
- Solo se aceptan imágenes JPEG, PNG o WebP como data URL, de hasta 2,2 MB.
- El contexto solo lleva productos. Nunca lleva clientes. Va al modelo en un mensaje aparte `<datos_pos>…</datos_pos>` marcado como solo dato (no en el mensaje system); `<` y `>` se escapan para que un nombre no cierre el bloque. El costo se quita si el rol no puede verlo (`purchases.costs.view`).
- Antes de llamar al modelo se ocultan DNI (`DNI ****1234`), RUC (`RUC *******1234`), teléfonos y correos, en el texto, el historial y el contexto.

Responde: `{ ok, mode: "deepseek"|"mock", role, reply, proposals: [...], denied: [{tool, message}], dropped: [{tool, reason}], left: {hoy, fotosHoy}, usage }`
Errores: 400 `bad_request|empty_message|bad_image`, 404 `not_found`, 503 `assistant_not_configured`, 413 `image_too_large|payload_too_large`, 429 `rate_limited|daily_limit|monthly_cap`, 502 `upstream_error`, 503 `upstream_busy`, 504 `upstream_timeout`.

Propuesta (tarjeta): `id` es un UUID que genera el servidor (`crypto.randomUUID()`) y va firmado en el token (`pid`); el cliente nunca lo arma. `{ id, type: "venta"|"compra"|"precio"|"documento"|"pasos", needsConfirm, title, ..., confirm_token }`

### `POST /auth/assistant/confirm`
Pide: `{ "token": "<confirm_token>", "proposal": <la propuesta sin confirm_token> }`
Tarjetas de dueño (`precio`, `compra`): además la cabecera `x-owner-approval: <approval_id>`. El approval se pide antes con `POST /auth/owner-approval {pin, action, operation_id}` donde `action` es `product.update` (precio) o `inventory.adjust` (compra) y `operation_id` es el `op` del token de ESA tarjeta (el cliente lo lee del token). Confirm verifica que la aprobación sea de este aparato, esta acción y este `operation_id`, y la gasta con `consumeApproval` (un solo uso; el reenvío de la misma tarjeta vuelve a pasar con la misma aprobación).
Compras (`compra`): las filas con datos fuera de rango llevan `revisar: [...]` (`cantidad` > 1000, `costo` > S/ 2000 o <= 0, `total` de fila > S/ 20000, `costo_raro` = más de 3 veces o menos de 1/3 del costo o precio conocido). Confirm repite esa revisión y responde **422 `review_required` `{rows}`** salvo que el cuerpo traiga `review: { op: <op del token>, accept: [filas], drop: [filas] }` que cubra cada fila marcada. Las filas en `drop` no se devuelven.
Responde 200: `{ ok: true, operation_id: "AST-<24 hex>", type, role, proposal }`. `proposal` es la propuesta verificada contra ESE token (con las filas quitadas); el celular aplica esa y no otra. Si se reenvía el mismo token: `{ ok: true, already_confirmed: true, operation_id: <el mismo> }`.
Rechazos: 422 `review_required|empty_after_review`, 400 `forbidden_param` (role, pin, approval, token, owner, admin...), 403 `bad_token|other_device|forbidden_role|owner_approval_required` (este último trae `action` y `operation_id`), 409 `proposal_id_mismatch|proposal_changed`, 410 `confirm_expired`, 429 `rate_limited` (5 por minuto por aparato), 503 `confirm_unavailable`.

## Herramientas que el modelo puede PROPONER
| Herramienta | Tipo de tarjeta | Dueño | Empleado | Acción de permisos | Qué pasa al pulsar Confirmar (función y ruta existentes) |
|---|---|---|---|---|---|
| `explicar_pasos` | `pasos` | sí | sí | `assistant.chat` | Nada se escribe. «Llévame ahí» usa `NA_MENU_NAVIGATION.navigate`. |
| `preparar_venta` | `venta` | sí | sí | `assistant.chat` | `posAdd(id)` llena el carrito. El cobro lo hace la persona con **Cobrar**, que va por `canonical-sale-outbox.js` → `POST /commands/sale.create` con su propio `operation_id`. |
| `preparar_documento` | `documento` | sí | sí | `assistant.chat` | Vista previa local imprimible, marcada «NO ES COMPROBANTE SUNAT». Sin ruta. |
| `preparar_compra` | `compra` | sí | **no** | `assistant.purchase.propose` (dueño) | Abre «Nueva compra» (`NA_PURCHASES.open`) llena. Registra la persona con «Registrar compra» → `POST /auth/purchases` (`ownerGate inventory.adjust`, `operation_id` propio de `opFor`). |
| `leer_factura_compra` | `compra` | sí | **no** | `assistant.purchase.propose` (dueño) | Igual que `preparar_compra`, con las líneas leídas de la foto. |
| `proponer_cambio_precio` | `precio` | sí | **no** | `assistant.price.propose` (dueño) | Abre la ficha (`editProd`) con el precio nuevo. Se aplica con Guardar → `canonical-product-bridge` → `POST /commands/product.update` (`ownerGate product.update`). |

- La tarjeta de dueño (`compra`, `precio`) pide además el **PIN del dueño**, que va solo a `POST /auth/owner-approval` con el `operation_id` de la tarjeta. Nunca llega al modelo ni al historial. Sin esa aprobación, confirm responde 403 aunque se llame por consola.
- Hoy el dueño real no tiene fila `owner` en `pos_device_roles`, así que el asistente lo trata como empleado y no le ofrece herramientas de dueño (ver PLAN.md).
- La misma llamada de herramienta repetida en una respuesta produce una sola tarjeta.
- Si el modelo pide una herramienta de dueño para un empleado, el Worker la descarta y responde `denied: [{tool, message: "Solo el dueño puede cambiar precios."}]`.

## Herramientas que NO existen (a propósito)
Crear producto (`product.create`, el servidor no filtra por rol), importar (`import.stage`, el servidor no filtra por rol), descuentos, anular ventas, reset o respaldo, cajeros, PIN, aparatos, configuración, reportes completos, abrir o cerrar caja, gastos y abonos.
Un abono futuro tendría que ir por `canonical-credit-payment-bridge.js` (`payment.create`/`payment.batch`), nunca por un camino propio.

## Cliente
- Cargador: `POS/js/modules/asistente/asistente-loader.js`. Solo se activa con `?asistente=1` (y se apaga con `?asistente=0`). Carga los archivos cuando el POS ya abrió y el navegador está libre.
- Lógica sin pantalla: `asistente-core.js` (`NA_ASISTENTE_CORE`). Pantalla: `asistente-ui.js` (`NA_ASISTENTE`). Estilos: `POS/css/asistente.css`.
- Estados de la burbuja: `listo`, `concentrado`, `pensando`, `hablando`, `feliz`, `error`, `offline`.
- Servidor local de prueba: `node tools/asistente-proto/dev-server.mjs 4471` (sirve POS/ y las dos rutas; el rol se simula con el encabezado `x-proto-role`).
