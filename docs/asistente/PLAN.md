# Asistente "Burbuja" para el modo admin del punto de venta (prototipo aislado)

Rama: `feature/asistente-aislado` (sale de `feature/v1.3-mobile-cloud`). No se unió a nada, no se publicó, no se desplegó y no se tocó producción. Todo se probó en esta máquina con datos inventados.

## 1. Qué hace (cambio de alcance del jefe: solo gestión, nada de ventas)
- Ayuda al **dueño** a gestionar: stock, compras, precios y documentos. No vende ni llena carritos.
- Puede: consultar (stock, por reponer, productos sin costo, ventas, más vendidos, deudas, compras), proponer ajustes de stock, cambios de precio, compras (también desde la foto de la factura), productos nuevos, y preparar documentos internos (inventario valorizado, lista de precios, lista de pedido, reporte de ventas, estado de cuenta, resumen de cierre). Ningún documento es comprobante SUNAT.
- Nada se hace solo: cada acción es una tarjeta con «Confirmar», vence en 5 minutos, se usa una vez y pide el PIN del dueño. Al confirmar se abre la pantalla que el POS ya tiene (movimiento de stock, ficha, nueva compra, nuevo producto) y se guarda por su ruta de siempre, con `ownerGate`/PIN. El asistente no tiene caminos de escritura propios.
- Para preguntas, el Worker manda al modelo solo un resumen (top 10), nunca el inventario completo. Medido: primer pedido ~6,8 KB; resumen de la consulta ≤ 3,2 KB incluso con 3.000 productos.

## 2. Quién lo ve
- **Dueño** (aparato con fila `owner`): tarjeta en Inicio «Puedo ayudarte con stock, compras, precios y documentos.» (en Inicio reemplaza a la burbuja) y burbuja flotante en el resto, abajo a la derecha sin tapar nada. Nunca sobre Cobrar.
- **Empleados**, por aparato, 3 niveles que elige el dueño en Configuración > Personal y seguridad > Aparatos conectados (se guarda solo y pide el PIN del dueño):
  - **Apagado** (por defecto): no ve nada y su teléfono **no baja ningún archivo del asistente** (el cargador pregunta primero al servidor con un ping de 13 bytes). Su POS arranca igual que hoy.
  - **Solo consultas**: burbuja con atajos; stock, qué falta reponer, cómo se hace algo y precios de venta. Sin costos, márgenes, caja ni deudas.
  - **Consultas y documentos**: además Lista de precios y Lista de pedido, sin costos (el servidor arma las filas y solo deja producto, stock y cantidad sugerida).
  - Un empleado puede **proponer** un ajuste, precio o compra, pero aplicarlo pide el PIN del dueño.
  - El servidor revisa el nivel en cada mensaje y en cada confirmación: apagar es inmediato, incluso con una tarjeta ya abierta.
- La navegación del celular (menú desplegable) no se tocó.

## 3. Cómo está armado
- POS (solo con `?asistente=1`, después de que el POS abrió): `asistente-loader.js` (ping primero), `asistente-core.js`, `asistente-ui.js`, `POS/css/asistente.css` (todo CSS, sin imágenes).
- Worker: `pos-assistant.js` (chat y confirm), `pos-assistant-queries.js` (consultas con lecturas canónicas), `pos-assistant-access.js` (niveles), `pos-owner-device.js` (registro del dueño, detrás de bandera). Todo apagado sin `ASSISTANT_ENABLED=1`.
- Aprobación del dueño estricta en todos lados: `UPDATE ... WHERE ... operation_id=? AND used_at IS NULL` y vale solo con `changes===1`.
- Detalle exacto: `docs/asistente/CONTRATO.md`.

## Costos
Precios oficiales de DeepSeek para `deepseek-flash`, revisados hoy, por millón de tokens:

| | Horario barato | Horario normal |
|---|---|---|
| Entrada | 0,15 USD | 0,30 USD |
| Entrada repetida (caché) | 0,003 USD | 0,006 USD |
| Salida | 0,60 USD | 1,20 USD |

El horario normal es de 01 a 04 y de 06 a 10 UTC en días de semana, o sea de noche y de madrugada en Lima. El día de trabajo en Lima cae casi todo en horario barato.

Cálculo para 100 chats y 20 fotos al día (30 días):
- Chats: unos 3.000 al mes, con unos 2.500 tokens de entrada y 250 de salida cada uno. Sale alrededor de 1,6 USD.
- Fotos: unas 600 al mes, con unos 4.000 tokens de entrada y 600 de salida cada una. Sale alrededor de 0,6 USD.
- Total: entre 2 y 6 USD al mes según el horario y lo largas que sean las conversaciones.

El número que se manejaba antes (8 a 15 USD al mes) queda como techo prudente. Con los topes que trae el prototipo (4.000 chats y 900 fotos al mes) el gasto máximo, todo en horario caro, sería de unos 9 USD al mes.

Importante: DeepSeek procesa los datos en servidores en China. Por eso el prototipo no manda nombres de clientes, DNI completos, teléfonos, correos, PIN ni claves. Solo manda el nombre, precio y stock de los productos, y el costo solo si el aparato es del dueño.

## 4. Riesgos y huecos conocidos
- **Privacidad**: DeepSeek procesa en China. Solo van resúmenes de productos; DNI, RUC, teléfonos y correos se ocultan antes. Una foto puede traer datos escritos: avisar que no fotografíen documentos de clientes.
- **El modelo se equivoca**: todo pasa por una tarjeta y por la pantalla normal del POS, con filas raras marcadas en rojo que bloquean Confirmar.
- **Hueco de raíz (heredado, no del asistente): registrar una compra NO actualiza el costo del producto.** El asistente no lo arregla por su cuenta: muestra «Costo actual S/ X → factura S/ Y» y ofrece «Actualizar costo» como tarjeta aparte por `product.update` con PIN. El arreglo de fondo en `/auth/purchases` queda para el jefe.
- **Pendientes heredados de Reportes** (se anotan también al pie de los documentos): el cierre de caja no separa bien efectivo de digital en todos los casos, y por el hueco anterior el inventario valorizado puede usar costos viejos.
- **El dueño real hoy no tiene fila `owner`**: el POS trata «sin fila» como dueño, el asistente no. Por eso existe el registro del dueño (abajo). Mientras no se active, el teléfono sin rol solo ve «Registrar este teléfono como dueño» (en el prototipo local se simula el dueño).
- **Inicio del dueño**: la tarjeta va ARRIBA, como en las maquetas. Para que no mueva la pantalla, el cargador reserva un hueco de alto fijo solo si el último ping guardado dijo dueño (ese dato solo reserva espacio). El margen se reserva desde el `<head>` (6 líneas en `index.html`, solo con `?asistente=1` y dueño guardado) porque el cargador `defer` corre después del primer pintado. Medido: CLS que agrega el asistente = 0 a 390, 768 y 1280 (lo que queda, 0.0024/0.0014/0.0008, es del POS y es igual sin asistente). Casos con salto, esperados: primera vez del dueño en el aparato (sin dato guardado) y aparato que era dueño y ya no lo es (el hueco se quita al instante).
- **Empleado apagado**: no baja nada del asistente (0 archivos). Por eso tampoco ve la tarjeta «Este teléfono ya es de empleado»; esa tarjeta solo la ve un empleado con el asistente encendido.
- **Compras desde el asistente (Bot 2)**: tope duro en el camino del asistente (cantidad 5000, costo por unidad S/ 10,000, fila S/ 50,000, compra S/ 200,000). «Está bien» no lo salta: hay que corregir la factura o quitar la fila. **La ruta de compras del POS (`/auth/purchases`, `pos-purchases.js`) no tiene tope**; no se tocó porque el núcleo está congelado.
- **Productos sin control de inventario**: el asistente no propone ajustes ni filas de compra para ellos (lo revisa al proponer y otra vez al confirmar, contra la base).
- **Compra pagada desde caja: no está hecho.** La compra que prepara el asistente no mueve la caja.
- **La compra no actualiza el costo**: el dueño usa la tarjeta aparte «Actualizar costo» (product.update con PIN).
- **Bitácora de herramientas (A20)**: cada propuesta, descarte y confirmación queda anotada (sin textos ni datos personales) en `pos_settings`, últimas 1000; la lee solo el dueño en `/auth/assistant/audit`. Sin migración nueva.
- **Arreglos de Bot 5 (P1)**: la aprobación del dueño se gasta justo antes de guardar la tarjeta (un 422 o 429 ya no la queman); el cambio de nivel de empleado ya no acepta PIN suelto y revisa el aparato destino antes de gastar la aprobación; `product.create`, `assistant.employee_access` y `assistant.owner_device` están en `OWNER_COMMANDS` (piden `operation_id`); el registro de dueños escribe rol, aprobación y bitácora en un solo `db.batch`.

## 5. Cambios que necesitan el visto bueno del jefe (no aplicados en ningún lado)
1. **`product.create` en el servidor del POS** (commit aparte `f5b3587c`): pasa por `ownerGate` (dueño, o PIN del dueño ligado al `operation_id`). Hoy cualquier aparato puede crear productos.
2. **Registro del aparato del dueño** (`pos-owner-device.js`, detrás de `ASSISTANT_OWNER_BOOTSTRAP=1`, commit aparte): botón explícito «Registrar este teléfono como dueño» con PIN; solo en un teléfono sin fila; con 0 dueños queda dueño, si ya hay uno queda «esperando aprobación» y el dueño lo aprueba o rechaza desde su teléfono con PIN; límite de PIN por aparato (5 fallos → 15 min); un empleado nunca sube a dueño; nunca se quita el último dueño (409 `last_owner`).
3. **Migraciones escritas y NO aplicadas** (antes de aplicarlas: copia de respaldo en R2 y OK del jefe):
   - `0034_pos_assistant_access_log.sql`: bitácora de cambios de nivel de empleados. Sin la tabla los cambios funcionan pero no quedan anotados (`logged:false`).
   - `0035_pos_owner_device_log.sql`: bitácora del registro de dueños. Sin la tabla las rutas de dueño fallan cerrado (503): no se registra nada sin bitácora.
4. Acciones nuevas en `APPROVAL_ACTIONS` (`pos-roles.js`, aditivo): `assistant.employee_access`, `assistant.owner_device`; y en `OWNER_COMMANDS`: `product.create`, `assistant.employee_access`, `assistant.owner_device`.
5. **Pendiente del jefe (no se cambió):** quitar un aparato dueño lo deja como **empleado** (no le borra la fila). Hay que decidir si debe quedar sin rol.
6. **Pendiente del jefe (no se cambió):** el tope global de **20 PIN fallidos** es compartido por todos los aparatos; un aparato puede gastar ese cupo y bloquear el PIN del dueño en los demás.
7. **Pendiente del jefe (núcleo congelado):** la ruta de compras del POS (`pos-purchases.js`) no tiene tope de cantidad ni de costo; el tope solo existe en el camino del asistente.

## 6. Siguientes pasos
1. Que el dueño lo pruebe con el servidor local y datos inventados.
2. Decidir si se acepta que los datos pasen por China.
3. Decidir los puntos de la sección 5.
4. Probar con una clave real de DeepSeek en un entorno de prueba con tope de gasto bajo.
5. Abonos: no hay herramienta a propósito; si se quiere, irían por `canonical-credit-payment-bridge`.
6. Recién después, un PR en borrador para revisión. Nada a producción sin aprobación.

## 7. Dónde ver las pruebas
- Pruebas automáticas: `tests/asistente/` (85 pruebas, todas pasan), incluye niveles de empleado, revocación inmediata, lista de pedido sin costos, registro del dueño, último dueño y el cargador (empleado en Apagado = 0 archivos).
- Capturas: `/workspace/asistente-proto/shots-admin/` (390, 768 y 1280; verde, nocturno y azul).
