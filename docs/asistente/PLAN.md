# Asistente "Burbuja" para el modo admin del punto de venta (prototipo aislado)

Rama: `feature/asistente-aislado` (sale de `feature/v1.3-mobile-cloud`). No se unió a nada, no se publicó, no se desplegó y no se tocó producción. Todo se probó en esta máquina con datos inventados.

## 1. Qué hace (cambio de alcance del jefe: solo gestión, nada de ventas)
- Ayuda al **dueño** a gestionar: stock, compras, precios y documentos. No vende ni llena carritos.
- Puede: consultar (stock, por reponer, productos sin costo, ventas, más vendidos, deudas, compras), proponer ajustes de stock, cambios de precio, compras (también desde la foto de la factura), productos nuevos, y preparar documentos internos (inventario valorizado, lista de precios, lista de pedido, reporte de ventas, estado de cuenta, resumen de cierre). Ningún documento es comprobante SUNAT.
- Nada se hace solo: cada acción es una tarjeta con «Confirmar», vence en 5 minutos, se usa una vez y solo la confirma el dueño, con un toque (sin PIN; el servidor exige la sesión dueño real). Al confirmar se abre la pantalla que el POS ya tiene (movimiento de stock, ficha, nueva compra, nuevo producto) y se guarda por su ruta de siempre, con `ownerGate`/PIN. El asistente no tiene caminos de escritura propios.
- Para preguntas, el Worker manda al modelo solo un resumen (top 10), nunca el inventario completo. Medido: primer pedido ~6,8 KB; resumen de la consulta ≤ 3,2 KB incluso con 3.000 productos.

## 2. Quién lo ve
- **Dueño** (aparato con fila `owner`): tarjeta en Inicio «Puedo ayudarte con stock, compras, precios y documentos.» (en Inicio reemplaza a la burbuja) y burbuja flotante en el resto, abajo a la derecha sin tapar nada. Nunca sobre Cobrar.
- **Empleados**, por aparato, 3 niveles que elige el dueño en Configuración > Personal y seguridad > Aparatos conectados (se guarda solo y pide el PIN del dueño; el PIN queda solo en Configuración):
  - **Apagado** (por defecto): no ve nada y su teléfono **no baja ningún archivo del asistente** (el cargador pregunta primero al servidor con un ping de 13 bytes). Su POS arranca igual que hoy.
  - **Solo consultas**: burbuja con atajos; stock, qué falta reponer, cómo se hace algo y precios de venta. Sin costos, márgenes, caja ni deudas.
  - **Consultas y documentos**: además Lista de precios y Lista de pedido, sin costos (el servidor arma las filas y solo deja producto, stock y cantidad sugerida).
  - Un empleado **no** propone ni aplica cambios (ajuste, precio, compra, producto): solo consulta y, según su nivel, documentos. Los cambios los hace el dueño desde su teléfono.
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
- **Inicio del dueño**: la tarjeta va ARRIBA, como en las maquetas. Para que no mueva la pantalla, el cargador reserva un hueco de alto fijo solo si el último ping guardado dijo dueño (ese dato solo reserva espacio). El margen se reserva desde el `<head>` (6 líneas en `index.html`, solo con `?asistente=1` y dueño guardado) porque el cargador `defer` corre después del primer pintado. Medido: CLS que agrega el asistente = 0 a 390, 768 y 1280 (lo que queda, 0.0024/0.0014/0.0008, es del POS y es igual sin asistente). Caso con salto, esperado: primera vez del dueño en el aparato (sin dato guardado). Si un aparato que era dueño deja de serlo, la tarjeta se vacía en el acto y queda un aviso neutro del mismo alto hasta salir de Inicio (sin salto).
- **Empleado apagado**: no baja nada del asistente (0 archivos). Por eso tampoco ve la tarjeta «Este teléfono ya es de empleado»; esa tarjeta solo la ve un empleado con el asistente encendido.
- **Compras desde el asistente (Bot 2)**: tope duro en el camino del asistente (cantidad 5000, costo por unidad S/ 10,000, fila S/ 50,000, compra S/ 200,000). «Está bien» no lo salta: hay que corregir la factura o quitar la fila. **La ruta de compras del POS (`/auth/purchases`, `pos-purchases.js`) no tiene tope**; no se tocó porque el núcleo está congelado.
- **Productos sin control de inventario**: el asistente no propone ajustes ni filas de compra para ellos (lo revisa al proponer y otra vez al confirmar, contra la base).
- **Compra pagada desde caja: no está hecho.** La compra que prepara el asistente no mueve la caja.
- **La compra no actualiza el costo**: el dueño usa la tarjeta aparte «Actualizar costo» (product.update con PIN).
- **Bitácora de herramientas (A20)**: cada propuesta, descarte y confirmación queda anotada (sin textos ni datos personales) en `pos_settings`, en tres cajones con tope propio: acciones del dueño (últimas 1000), empleados y confirmaciones rechazadas (últimas 300) y los 429 / 403 de rol agrupados en una fila por aparato, minuto y resultado con `count` (últimas 300). Un empleado insistiendo nunca saca filas del dueño (prueba). La lee solo el dueño en `/auth/assistant/audit`. Sin migración nueva. Si anotar falla, el chat sigue, el Worker avisa con `console.warn` (solo el código de error) y el contador `write_errors` aparece en esa ruta.
- **Revisión de lecturas de `pos_settings` (pedido de Bot 3)**: ninguna lectura que llega al celular o corre al arrancar trae las filas internas.
  - `pos-roles.js:224` (`GET /settings`, la única que usa el POS: `config-g.js:214`) filtra `key NOT LIKE 'internal:%'`. Recorre la tabla entera (como máximo 1600 filas de bitácora: despreciable).
  - Por clave exacta: `a6-commerce.js:62`, `pos-dni-lookup.js:52`, `pos-roles.js:312`, `pos-assistant.js:318`, `pos-assistant-access.js:25`, `pos-product-images.js:19,30,71,84`, `pos-owner-device.js:132,133,142,144`.
  - Por prefijo propio: `pos-product-images.js:20,31,61,103,108` (`internal:img:*`), `pos-owner-device.js:42` (`internal:asst:odev:*`), `pos-assistant-audit.js:24,43` (`internal:asst:audit:*`).
  - El cliente del POS no lee `pos_settings` directo; sync, snapshot y lecturas canónicas (`a6-canonical.js`) no tocan esa tabla.
  - **Respaldo** (`tools/cloudflare-prod/scripts/backup-select.mjs:3`, `tools/cloudflare-backup/src/backup-core.js:47`): solo saca `internal:img*`, así que las ≤1600 filas de bitácora (~0,5 MB) van en el respaldo. No se tocó (herramienta de producción); el jefe decide si se excluyen.
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
- Pruebas automáticas: `tests/asistente/` (144 pruebas, todas pasan), incluye niveles de empleado, revocación inmediata, lista de pedido sin costos, registro del dueño, último dueño y el cargador (empleado en Apagado = 0 archivos).
- Capturas: `/workspace/asistente-proto/shots-admin/` (390, 768 y 1280; verde, nocturno y azul).

## Sobre 1b87710d (revisión de Bots 2, 3, 4 y 5) — pendiente de decisión del jefe
- **Primera visita a Inicio (Bot 3/Bot 4):** la tarjeta ya no entra arriba con Inicio a la vista (era CLS 0,14-0,22). Mientras tanto se ve la burbuja; la tarjeta entra al salir de Inicio o en el próximo arranque (el `<head>` ya reserva su alto). La idea de Bot 3 de guardar el rol al iniciar sesión, para que la PRIMERA vez ya esté reservado, necesita tocar el inicio de sesión del POS (el ping del asistente corre después del primer pintado). No se hizo porque el núcleo está congelado: queda como sugerencia para el jefe.
- **GET /settings del núcleo (Bot 3):** `pos-roles.js` lista con `key NOT LIKE 'internal:%'`, que recorre toda `pos_settings`. El asistente ya usa rangos por clave (`key >= p AND key < p+1`) en su bitácora y en el registro de aparatos de dueño. Sugerencia para el jefe: el mismo cambio en GET /settings (no se tocó: POS congelado).
- **Tarjetas de compra:** el chat sigue limitando cada compra a 30 filas; el confirm ya revisa cualquier cantidad de productos en tramos de 50 ids.
- **Compras del POS** (`/auth/purchases`): siguen sin tope propio (pendiente de antes).

## Notas sobre 50b6716b (17-10-2026)
- Re-chequeo del permiso: el cargador mira Inicio con un MutationObserver sobre `#pageMenu` (no toca el menú). No hay evento «POS listo para vender» en el núcleo; se usa `load` + `requestIdleCallback`. Si jefe quiere un evento propio del núcleo, sería un cambio fuera del asistente (no hecho).
- El servidor de prueba (`tools/asistente-proto/dev-server.mjs`) cambia el id del aparato con el rol simulado; por eso un `forbidden_role` del confirm se simuló en la verificación de navegador (en el Worker real el aparato es el mismo).

## Pedido sin PIN y simplicidad (17-10-2026)
- **Confirmar sin PIN:** la tarjeta mantiene el resumen (producto, antes → después) y «Confirmar» de un toque. El servidor sigue exigiendo la sesión dueño real (fila `owner` + sesión owner del POS); sin ella, 403. Un doble toque no repite (mismo `operation_id`).
- **Empleados sin escritura:** siguen con «Solo consultas» o «Consultas y documentos» (ya sin PIN). No se creó ningún nivel nuevo de escritura.
- **El PIN queda solo en Configuración:** cambiar el nivel de un empleado y registrar/aprobar/quitar aparatos dueño (a confirmar por el dueño si también lo quiere sin PIN).
- **Pantallas del POS:** el asistente solo abre la pantalla que ya existe; si esa pantalla del POS pide su propio PIN al Guardar, eso es del núcleo (congelado) y no se tocó.
- **Fácil y sin marear:** respuestas de 2-3 frases, español sencillo sin palabras técnicas, una sola pregunta si falta un dato, una sola tarjeta por acción (también filtrado en el servidor). Errores siempre en palabras simples con «Reintentar» cuando sirve; nunca un «Pensando» sin fin. Al empleado no se le muestra el botón de foto de factura ni tarjetas de cambio. Botones rápidos de 44 px o más.

### Sugerencias pendientes de decisión del dueño (no implementadas)
1. **Tiempo de inactividad:** pedir de nuevo la sesión dueño (o cerrar el asistente) tras X minutos sin usar el teléfono, por si queda desbloqueado en el mostrador.
2. **PIN para montos grandes:** volver a pedir el PIN solo cuando el cambio pase un tope (por ejemplo, compra mayor a S/ X o cambio de precio mayor a 50 %).

### Siguiente paso: respuesta en streaming (para que Bot 3 la mida)
- Hoy la respuesta llega entera (DeepSeek sin `stream`). Objetivo: **primera palabra en 1-2 s** mostrando el texto mientras llega (SSE desde el Worker), y las tarjetas al final, cuando el servidor ya las firmó.
- No se implementó en esta ronda. Bot 3 debería medir antes el tiempo hasta la primera palabra y hasta la respuesta completa (390 en 4G lenta y 1280) para comparar después.
