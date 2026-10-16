# Asistente "Burbuja" dentro del punto de venta (prototipo aislado)

Rama: `feature/asistente-aislado` (sale de `feature/v1.3-mobile-cloud`). No se unió a nada, no se publicó, no se desplegó y no se tocó producción. Todo se probó en esta máquina con datos inventados.

## 1. Qué hace
- Una burbuja verde con ojos grandes flota en la pantalla. Nunca tapa el botón Cobrar ni el carrito (celular, tablet y PC). Se esconde sola cuando se abre una ventana del POS.
- Al tocarla se abre un chat en español, con letra grande y botones grandes.
- La persona puede escribir o mandar una foto (por ejemplo, la factura de un proveedor). La foto se achica en el celular antes de enviarse.
- El asistente puede:
  - Explicar pasos ("¿cómo abro la caja?") y llevar a la pantalla correcta.
  - Preparar una venta: llena el carrito. El cobro lo sigue haciendo la persona con Cobrar, igual que hoy.
  - Preparar una compra o leer la foto de una factura: abre "Nueva compra" ya llena para revisar. Solo dueño.
  - Proponer un cambio de precio: abre la ficha del producto con el precio nuevo. Solo dueño.
  - Hacer una vista previa de documento (nota de venta, cotización, lista de precios). No es comprobante SUNAT y lo dice en la hoja.
- Nada se hace solo. Cada acción sale como una tarjeta con "Confirmar". La tarjeta vence en 5 minutos, se usa una sola vez y las de dueño piden el PIN del dueño. El servidor exige ese PIN: la aprobación queda ligada al número de operación de esa tarjeta y se gasta al confirmar, así que no se puede saltar desde la consola del navegador.
- Si el aparato es de empleado y pide algo de dueño, la respuesta es "Solo el dueño puede cambiar precios."
- Sin internet la burbuja se pone gris y dice "Asistente no disponible sin internet".
- Estados de la burbuja: Listo, Concentrado, Pensando, Hablando, Feliz, Error y Sin internet. Las animaciones bajan de calidad solas en celulares lentos, con batería baja o si el usuario pidió menos movimiento, y se pausan si la pestaña no se ve.

## 2. Cómo está armado
- En el POS (archivos nuevos, se cargan solo con `?asistente=1` y después de que el POS ya abrió):
  - `POS/js/modules/asistente/asistente-loader.js`: decide si se carga.
  - `POS/js/modules/asistente/asistente-core.js`: quita datos sensibles, arma el contexto y controla que nada se ejecute sin Confirmar.
  - `POS/js/modules/asistente/asistente-ui.js` y `POS/css/asistente.css`: burbuja, chat y tarjetas.
- En el Worker:
  - `tools/cloudflare-lab/src/pos-assistant.js`: rutas `POST /auth/assistant/chat` y `POST /auth/assistant/confirm`.
  - Apagado por defecto: sin `ASSISTANT_ENABLED=1` responde 404.
  - La clave de DeepSeek vive solo en el Worker (`DEEPSEEK_API_KEY`). Sin clave responde "asistente no configurado" (503). El modo demostración solo se enciende a propósito con `ASSISTANT_DEMO=1`, para el prototipo local y las pruebas.
  - Modelo `deepseek-flash`, sin modo "pensar", con herramientas. La dirección se puede cambiar con `DEEPSEEK_BASE_URL` (así se probó con el mock de Bot 2).
- Seguridad:
  - El rol lo decide el servidor. Para el asistente, un aparato sin fila de rol cuenta como empleado.
  - Cada propuesta lleva un número único que crea el servidor y va firmado. Si el celular manda otro número, se rechaza.
  - Los nombres de productos van al modelo en un bloque aparte marcado como solo dato, no junto a las reglas.
  - Cada rol solo recibe sus herramientas. El empleado nunca ve las de dueño.
  - Se rechazan parámetros como role, pin, approval o token.
  - Antes de llamar al modelo se ocultan DNI, RUC, teléfonos, correos, PIN, claves y tokens.
  - El texto del chat y la foto se tratan como datos, nunca como órdenes.
  - Confirmar solo gasta el token y devuelve un `operation_id` fijo. Si se toca dos veces o se corta la señal, se devuelve el mismo número y no se duplica nada.
  - Lo que de verdad guarda datos son las funciones que el POS ya tiene: Cobrar con su cola de ventas, "Registrar compra" con PIN del dueño, y la ficha del producto con PIN del dueño.
- No hay herramientas para crear productos, importar, descuentos, anular ventas, reset o respaldo, cajeros, reportes completos ni abonos.
- El detalle exacto está en `docs/asistente/CONTRATO.md` de la rama.

## 3. Costos
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

## 4. Riesgos
- Privacidad: los datos van a China. Mitigado con el filtro de datos, pero una foto puede traer datos de clientes escritos. Conviene avisar a los usuarios que no fotografíen documentos de clientes.
- El modelo se equivoca: puede leer mal una factura o entender mal un pedido. Mitigado porque todo pasa por una tarjeta y por la pantalla normal del POS, donde la persona revisa antes de guardar.
- Inyección (un texto o foto que intenta dar órdenes): probado con el mock de Bot 2 y la suite de Bot 5. No se ejecutó nada no permitido.
- Costo: si alguien abusa, los límites por aparato (por minuto y por día) y el tope mensual lo frenan.
- Dependencia de internet y de DeepSeek: sin internet o si DeepSeek falla, el asistente dice que no está disponible y el POS sigue funcionando igual.
- Velocidad del POS: el asistente se carga después de que el POS abrió y solo si se activa. Las animaciones bajan de calidad solas.
- El dueño hoy aparece como empleado para el asistente. Ningún código crea la fila "owner" en la tabla de roles de aparatos: solo se crean filas de empleado al vincular una caja. El resto del POS trata "sin fila" como dueño, pero el asistente, por seguridad, lo trata como empleado. Resultado: el dueño real no ve las herramientas de dueño (precios y compras) en el asistente. No se tocó ningún dato de roles. El arreglo, que necesita la aprobación del dueño, sería una forma aprobada de marcar su aparato como "owner" (por ejemplo, un paso en Configuración que pida su PIN y guarde esa fila), o una migración que lo haga una sola vez.
- Falta un registro de auditoría en el servidor. Hacerlo necesita una migración de base de datos, y eso requiere aprobación del dueño.

- Arranque con la app instalada y mala señal (hallazgo de Bot 3, fuera del asistente, NO se arregló porque el POS está congelado): varios archivos que no son del asistente se piden a la red en cada arranque porque no están en la lista de precarga del service worker. Por ejemplo `pos-permissions.js`, `runtime-config.js`, `theme-state.js` y `cash-perf-probe.js`. Con señal colgada pueden demorar el arranque. Es un arreglo aparte, para cuando el dueño lo apruebe. El cargador del asistente sí se agregó a esa lista y se carga con `defer`.

## 5. Siguientes pasos
1. Que el dueño lo pruebe en un celular de la tienda con el servidor local y datos inventados.
2. Decidir si se acepta que los datos pasen por China. Si no, se puede cambiar de proveedor sin rehacer el POS.
3. Si se aprueba: crear la tabla de auditoría (necesita aprobación del dueño para la migración).
4. Probar con una clave real de DeepSeek en un entorno de prueba con tope de gasto bajo.
5. Más adelante, si se quiere, sumar abonos, siempre por el camino que ya existe (`canonical-credit-payment-bridge`).
6. Solo después de todo eso, pensar en un PR en borrador para revisión. Nada a producción sin aprobación.

## 6. Dónde ver las pruebas
- Capturas: `/workspace/asistente-proto/shots/` (390x844, 768 y 1280x800, tema verde y nocturno).
- Videos: `/workspace/asistente-proto/asistente-estados-390.mp4` y `asistente-estados-1280.mp4` (también en .webm).
- Pruebas automáticas: `tests/asistente/` en la rama (45 pruebas, todas pasan).
- Suite de permisos de Bot 5 (versión actualizada, contrato `contrato-bot5-adaptado.json`) sobre 0b6fb5fd: 39 pasan, 1 brecha que ya estaba en la rama base (L07), 1 no aplica (no hay abono a propósito), 6 informativas, 1 pendiente (interfaz). Tres fallan: A20 (falta la tabla de auditoría, necesita migración aprobada), R01 (la prueba manda el PIN como la interfaz vieja, sin operation_id; la interfaz nueva sí lo manda y la prueba de punta a punta pasa) y R07 (el mock de Bot 5 aún no tiene el escenario `dos_ventas`; el caso de dos tarjetas está cubierto en `tests/asistente/`).
