# Contrato del asistente (prototipo aislado, rama feature/asistente-aislado)

Estado: prototipo. Apagado por defecto. No se publica, no se une y no se despliega. Alcance: **solo gestión (modo admin)**: documentos, mercadería, stock, compras y precios. **No vende ni llena carritos.**
Copia del contrato de pruebas de Bot 5 adaptada a esta rama: `docs/asistente/contrato-asistente-v2.json`.

## Rutas del Worker
| Ruta | Método | Roles (tabla `API_ROUTES`) | Qué hace |
|---|---|---|---|
| `/auth/assistant/chat` | POST | dueño, empleado (el servidor revisa el nivel) | Conversa con DeepSeek y devuelve propuestas. Nunca escribe datos del negocio. `{ping:true}` devuelve `{ok, role, level, server_now}` sin llamar al modelo ni gastar cupo. |
| `/auth/assistant/confirm` | POST | dueño, empleado (nivel revisado OTRA vez) | Gasta el token de UNA tarjeta (un uso, 5 min). Devuelve el `operation_id`. No escribe datos del negocio. |
| `/auth/assistant/employee-access` | GET, POST | dueño | Lista los aparatos de empleado con su nivel / cambia el nivel (dueño + aprobación estricta). |
| `/auth/assistant/owner-device` | GET | dueño | Aparatos dueño y pendientes de aprobar. **Bandera `ASSISTANT_OWNER_BOOTSTRAP=1`.** |
| `/auth/assistant/owner-device/register` | POST | aparato sin fila de rol | «Registrar este teléfono como dueño» `{pin}`. **Bandera.** |
| `/auth/assistant/owner-device/approve` | POST | dueño | `{device_id, operation_id, decision:"approve"|"reject"}` + `x-owner-approval`. **Bandera.** |
| `/auth/assistant/owner-device/revoke` | POST | dueño | `{device_id, operation_id}` + `x-owner-approval`. **Bandera.** |

- Todas responden **404** sin `ASSISTANT_ENABLED=1` (antes de pedir sesión). Las de `owner-device` además responden 404 sin `ASSISTANT_OWNER_BOOTSTRAP=1`.
- No existen `/auth/assistant/tool` ni `/auth/assistant/audit`: el modelo no ejecuta nada.
- Sesión: `authorizeSession` (Bearer). Rol y nivel se calculan **en cada pedido** con `assistantAccess(db, auth)` (sin caché en el cliente): `owner` solo con `pos_device_roles.pos_role='owner'` explícito; si no, `empleado:<nivel>` (nivel en `pos_settings`, clave `internal:asst:lvl:<hash del aparato>`, por defecto `off`). Sin tabla o con error: `off`.

### Variables del Worker
| Variable | Uso |
|---|---|
| `ASSISTANT_ENABLED` | `1` para encender. Otro valor: 404. |
| `ASSISTANT_OWNER_BOOTSTRAP` | `1` para las rutas `owner-device`. Necesita el visto bueno del jefe y la migración 0035 (no aplicada). |
| `DEEPSEEK_API_KEY` | Secreto, solo en el Worker. Sin clave: 503 `assistant_not_configured`, salvo `ASSISTANT_DEMO=1`. |
| `ASSISTANT_DEMO` | Solo prototipo local y pruebas (respuestas de demostración). Nunca en un Worker real. |
| `DEEPSEEK_BASE_URL` | Opcional (mock de Bot 2: `http://127.0.0.1:4599`). |
| `ASSISTANT_CONFIRM_SECRET` | HMAC de los tokens (16+ caracteres). Sin él no se confirma nada (503). |
| Límites `ASSISTANT_*` | Por minuto (dueño 30, empleado 10), fotos, por día, tope mensual, confirms por minuto. |

Modelo fijo: `deepseek-flash`, `thinking: {type:"disabled"}`, `tool_choice:"auto"`.

## Matriz de roles
| | Dueño | Empleado «Consultas y documentos» | Empleado «Solo consultas» | Empleado «Apagado» (por defecto) / sin rol |
|---|---|---|---|---|
| Chat / confirm | sí | sí | sí | **403** `assistant_off` (empleado) / `admin_only` + `reason:"sin_rol"` (aparato sin fila) |
| Qué ve | tarjeta en Inicio (reemplaza la burbuja ahí) + burbuja flotante en el resto | solo la burbuja flotante con sus atajos | igual | **nada**: el cargador no baja ni un archivo del asistente (0 JS, 0 CSS) |
| `consultar` | todo: stock, bajo stock, sin costo, ventas, más vendidos, deudas, compras | stock, por reponer, precios de venta (sin costos, márgenes, caja ni deudas) | igual | — |
| `preparar_documento` | 6 tipos | solo `lista_precios`, `lista_pedido` (sin costos, armadas en el servidor) | **no** | — |
| `explicar_pasos` | sí | sí | sí | — |
| Proponer ajuste de stock, precio, compra, producto nuevo | sí, se aplica con su PIN | puede **proponer**; aplicar pide el **PIN del dueño** | igual | — |
| `Actualizar costo` (tarjeta aparte) | sí, con PIN | no | no | — |
| Cambiar nivel de empleados / aparatos dueño | sí, con PIN (aprobación estricta) | no | no | — |

Revocar es inmediato: confirm vuelve a leer el nivel; una tarjeta emitida antes de apagar responde **403**.

## Herramientas (el modelo solo PROPONE)
| Herramienta | Tarjeta | Qué pasa al pulsar (pantalla o ruta que ya existe) |
|---|---|---|
| `consultar {tipo, producto?, desde?, hasta?}` | `consulta` (solo lectura) | El Worker lee con las lecturas canónicas (`canonicalRead`) y manda al modelo **solo un resumen** (top 10). Medido: primer pedido ~6,8 KB; resumen ≤ 3,2 KB aun con 3.000 productos. |
| `preparar_documento {tipo, desde?, hasta?, cliente?}` | `documento` | Vista previa imprimible «No es comprobante SUNAT». `tipo`: `inventario_valorizado`, `lista_precios`, `lista_pedido`, `reporte_ventas`, `estado_cuenta`, `resumen_cierre`. Reusa `NA_VALORIZACION`, `NA_REPORTE_ARQUEO`, `NA_CLIENT_CREDIT_ACCOUNTS_V2` (sin cuentas propias). |
| `proponer_ajuste_stock {product_id, tipo, cantidad, motivo}` | `ajuste` | Abre «Registrar movimiento» (`abrirMovInv`) lleno; guarda con PIN (`ownerGate inventory.adjust`). |
| `proponer_cambio_precio` | `precio` | Abre la ficha (`editProd`); Guardar → `product.update` (`ownerGate`). |
| `preparar_compra` / `leer_factura_compra` | `compra` | Abre «Nueva compra» (`NA_PURCHASES.open`) llena; filas fuera de rango bloquean Confirmar. La compra NO cambia el costo: «Actualizar costo» es tarjeta aparte por `product.update` con PIN. |
| `proponer_producto_nuevo` | `producto` | Abre el formulario de producto lleno; confirm exige dueño + aprobación `product.create`. |
| `explicar_pasos` | `pasos` | Nada se escribe; «Llévame ahí» navega. |

**Lista de pedido del empleado:** el servidor la arma y la pasa por lista blanca: la tarjeta solo trae `id, type, needsConfirm, title, tipo, fiscal, data{campos:["producto","stock","cantidad_sugerida"], columnas, filas}`. Costos, totales o inversión que mande el modelo se descartan (probado con los canarios 4321.97 / 999.11). La versión del dueño puede traer costo e inversión.

## Aprobación estricta (PIN del dueño)
`POST /auth/owner-approval {pin, action, operation_id}` → `approval_id`. La ruta que la usa la gasta con
`UPDATE pos_owner_approvals SET used_at=? WHERE approval_id=? AND device_id=? AND action=? AND expires_at>? AND operation_id=? AND used_at IS NULL` y solo vale con `changes===1`.
Acciones: `inventory.adjust`, `product.update`, `product.create`, `assistant.employee_access`, `assistant.owner_device` (agregadas a `APPROVAL_ACTIONS` en `pos-roles.js`, cambio aditivo).

### `POST /auth/assistant/employee-access`
`{device_id, operation_id, level:"off"|"consultas"|"consultas_documentos"}` (también `enabled: true→consultas, false→off`) + `x-owner-approval` (`assistant.employee_access`). Respuesta `{ok, device_id, level, logged}`. Se anota en `pos_assistant_access_log` si existe (migración 0034, **no aplicada**).

### Aparato del dueño (`owner-device`, detrás de bandera)
- `register {pin}`: solo un aparato **sin fila**; empleado → 409 `employee_device_cannot_register` (o 403 `forbidden_role` del gate), sin gastar intentos. PIN con el límite por aparato existente (5 fallos → 429, «Demasiados intentos. Espera 15 min.»). Con 0 dueños → `owner` (INSERT atómico). Con dueño → **202** `{pending:true, status:"esperando_aprobacion"}`.
- `approve {device_id, operation_id, decision}`: `approve` crea la fila owner; `reject` borra el pedido. Ambos piden aprobación estricta `assistant.owner_device`; un PIN suelto no basta.
- `revoke {device_id, operation_id}`: deja el aparato como `empleado`. El último dueño nunca se quita: **409 `{error:"last_owner", code:"last_owner"}`** (revisado antes de gastar la aprobación y otra vez dentro del UPDATE). La pantalla avisa antes de quitar cualquier aparato dueño.
- Bitácora `pos_owner_device_log` (migración 0035, **no aplicada**). Sin la tabla: **503 `owner_device_log_missing`**, no se registra nada.

## Confirm
Pide `{token, proposal}`; tarjetas con PIN además `x-owner-approval` ligada al `op` del token. Orden: firma, aparato, **rol y nivel actuales**, parámetros, id y hash, ya usada (`already_confirmed`, mismo `operation_id`), vencida (410), aprobación, revisión de filas (422 `review_required`). El `id` de cada tarjeta lo crea el servidor (`crypto.randomUUID()`) y va firmado.

## Lo que NO existe (a propósito)
Ventas o carrito, comprobantes SUNAT, importar, descuentos, anular ventas, reset o respaldo, cajeros, PIN, abrir o cerrar caja, gastos y **abonos** (un abono futuro iría por `canonical-credit-payment-bridge.js`).

## Cliente
- Cargador `asistente-loader.js` (solo con `?asistente=1`, después de que el POS abrió). `asistente-core.js` (`NA_ASISTENTE_CORE`), `asistente-ui.js` (`NA_ASISTENTE`), `POS/css/asistente.css` (sin imágenes: burbuja 100 % CSS).
- Cargador: antes de bajar el asistente hace UN ping (`POST /auth/assistant/chat {"ping":true}`, cuerpo de 13 bytes, sin modelo ni cupo). Solo con 200 (dueño o empleado encendido) o 403 `reason:"sin_rol"` carga `asistente.css`, `asistente-core.js` y `asistente-ui.js`. Empleado en Apagado: 0 archivos, su POS arranca igual que hoy (prueba `assistant-loader.test.mjs` y medición en navegador). Sin internet solo carga si el último ping dijo dueño (`localStorage na_asistente_acc`). Vuelve a preguntar al volver a la app (máx. cada 30 s).
- Inicio: tarjeta **solo para el dueño**, después de que el servidor lo confirma; va debajo del contenido que ya existe, así no mueve nada. Sin internet: «Asistente no disponible sin internet.»; el resto de Inicio sigue igual. Burbuja flotante abajo a la derecha sin tapar nada; en Inicio la reemplaza la tarjeta. El menú desplegable del celular (Inicio, Punto de Venta, Ventas, Inventario, Clientes, Caja, Gastos, Configuración) no se tocó.
- Configuración > Personal y seguridad > Aparatos conectados: selector de 3 niveles por aparato de empleado (se guarda solo, pide PIN), aparatos dueño con «Quitar» (aviso previo) y «Pendiente de aprobar» con Aprobar/Rechazar. En un teléfono sin rol: «Registrar este teléfono como dueño».
- Servidor local: `node tools/asistente-proto/dev-server.mjs 4471` (rol simulado con `x-proto-role`: dueño, `empleado`, `sinrol`; nivel con `x-proto-level`; PIN `0000` simula PIN incorrecto).
