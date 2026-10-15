# Contexto de negocio — Nuevo Amanecer POS

## Qué es
Nuevo Amanecer es la tienda propia del owner. El POS es **un solo sistema integrado** para farmacia + abarrotes + otros productos (un catálogo, una caja, un inventario).

- País: Perú. Zona horaria America/Lima (UTC-5, sin horario de verano). Moneda: soles (S/), montos en el backend en céntimos enteros.
- Utilidad de hora Lima en el cliente: `POS/js/core/lima-time.js`. Un timestamp sin zona se interpreta como hora de Lima (`-05:00`), nunca UTC.

## Farmacia: lotes y vencimientos
- Los productos pueden tener lotes con fecha de vencimiento (`POS/js/inventory/stock-lots.js`, backend `tools/cloudflare-lab/src/stock-lots.js`, migración `infra/database/migrations/0030_canonical_stock_lots.sql`, doc `docs/LOTES_FEFO.md`).
- Orden de consumo **FEFO** (primero en vencer, primero en salir).
- La venta de lotes vencidos está **bloqueada por defecto**; solo se permite si el ajuste del owner lo habilita y con PIN del dueño (`expired_lot_sale`).

## Caja (turnos)
- Abrir / cerrar caja; se registra el cajero que abrió y el que cerró (migración `0031_canonical_cash_session_cashier.sql`, backend `tools/cloudflare-lab/src/cash-session-cashier.js`).
- Egresos/gastos y salidas de efectivo del turno.
- Un empleado solo puede registrar `cash.expense` (salida en efectivo) **en su propio turno abierto** (`employeeCashExpenseAllowed` en `tools/cloudflare-lab/src/a6-expenses.js`).
- Los empleados **nunca** ven la lista de gastos del negocio: `/read/canonical/expenses` es solo del owner y el snapshot omite gastos para empleados.
- Historial de caja: `POS/js/modules/caja-movimientos-historial.js`.

## Roles y permisos
- Dos roles: `owner` (dueño) y `empleado`. Cualquier otro valor o rol no confirmado = sin permisos (fail-closed).
- Tabla única compartida cliente/servidor: `POS/js/config/pos-permissions.js` (pantallas `SCREENS`, acciones `ACTIONS`, entidades de sync, rutas API `API_ROUTES`). El Worker la importa vía `tools/cloudflare-lab/src/pos-permissions.js`; una ruta no listada es solo-owner (**denegación por defecto**).
- Cliente de roles (confirmación con el servidor, PIN del dueño, pantalla «Sin permiso»): `POS/js/config/pos-roles-client.js`. Backend: `tools/cloudflare-lab/src/pos-roles.js`.
- Mientras el rol no está confirmado, el menú muestra solo lo permitido a empleado y la etiqueta «Verificando permisos…».

## Próximamente
- Registro de funciones bloqueadas, solo visible para el owner: `POS/js/modules/proximamente.js` (+ `POS/css/proximamente.css`, página `#pageProximamente`).
- Una función se desbloquea solo con `enabled: true` **y** `page` definido; las vistas previas son de solo lectura y no guardan datos.
- Acceso: menú móvil (drawer) y menú de Configuración, solo owner. No aparece en Inicio.

## Fotos de productos
Se guardan en el servidor (`tools/cloudflare-lab/src/pos-product-images.js`); cliente `POS/js/products/image-sync.js` y `POS/js/products/image-batch.js`. Subir/borrar es solo owner.

## Diseño
- Debe funcionar en **1366, 768 y 390 px**, teléfono primero.
- Referencia visual: estilo tipo CasaMarket (limpio, tarjetas, iconos de línea).
- **Nunca cambiar el layout de la pantalla Venta (`#pagePOS`) ni de Inicio (`#pageMenu`)**; sí se pueden mejorar sus funciones internas.

## Datos y producción
- CANON es la única fuente funcional. Migraciones de BD/CANON requieren aprobación del owner y respaldo previo; solo aditivas.
- Nunca alterar ventas ni abonos pendientes (outbox local, operaciones sin confirmar).
- Nunca tocar datos de producción desde pruebas; nunca pulsar «Pagar» contra producción.
