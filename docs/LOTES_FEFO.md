# Lotes y vencimiento CANON

## OBJECTIVE
Registrar ingresos por lote, vender FEFO, devolver los mismos lotes al anular y consultar productos a vencer, conservando la autoridad CANON.

## IN_SCOPE
Inventario/compras, venta/anulación, réplica/outbox existente, reporte responsive, respaldo/restauración y migración aditiva 0030. Riesgo CRITICAL por stock y efectos cruzados.

## OUT_OF_SCOPE
Red, commits, PR, deploy, migración remota, cambios de secrets, datos reales y producto LAB. Compras completas y anulaciones mantienen su orquestación recuperable actual; cada efecto de inventario es atómico.

## ACCEPTANCE_CRITERIA
Lotes opcionales en unidad física, suma <= stock; FEFO por vencimiento/ingreso/id; sin lote después de vigentes; vencidos solo con confirmación explícita por venta; devolución exacta; reporte acumulativo 30/60/90 y vencidos; recarga/retry sin duplicar; respaldo incluye lotes; tests solicitados ejecutados sin cambiar tests existentes.

## INVARIANTS
Stock total conserva autoridad y revisión CAS. Cada ingreso genera IDs de lote derivados del operation_id e índice, incluso si otro ingreso usa el mismo código. La asignación se guarda por operación/producto/lote (ID vacío representa sin lote). El backend calcula FEFO; no confía en una asignación del cliente. El vencimiento es inclusivo: se puede vender en esa fecha, vencido cuando fecha < día comercial Lima de created_at. Offline conserva created_at y confirmación; el backend vuelve a evaluar el stock actual y rechaza conflictos sin efectos parciales. Una autorización para usar vencidos solo existe si el operador acepta el diálogo para esa venta; no se recuerda para otras ventas. La confirmación permite completar con vencidos después de vigentes y sin lote. SALIDA manual consume también FEFO y exige confirmación para vencidos. Anulación usa el registro original, no recalcula FEFO. Clientes/datos sin lotes mantienen el camino existente. Lotes no activan stock en productos sin control.

Las SALIDAS de productos con lotes y ventas pendientes del mismo producto se bloquean hasta confirmar esas ventas: el Worker aún no conoce la reserva local. Esto incluye cantidades decimales. Los receipts conservan asignaciones reales; la proyección del ACK actualiza stock/lotes/revisión conjuntamente y marca lo ya reservado. El reporte comparte la proyección de venta para incluir receipts entre ACK y refresh. Los rechazos definitivos de vencidos quedan en revisión durable sin bloquear otras ventas ni autorizar vencidos automáticamente.

La cabecera y las líneas/lotes de compra son un solo batch: una assertion impide que una petición simultánea con el mismo id inserte lotes en el recibo de otra. Una carrera compara contenido durable antes de aplicar stock. La venta normal agrupa todas las lecturas de lotes en una consulta; no añade una llamada externa por producto.

## EXPECTED_FILES
POS/js/inventory/stock-lots.js, POS/js/inventory/stock-lots-ui.js, POS/css/stock-lots.css; puntos existentes de sync, adapter, compras, respaldo, index y SW; Worker a6-inventory/a6-commerce/a6-canonical/pos-purchases/pos-sale-annul y módulo stock-lots; infra/database/migrations/0030_canonical_stock_lots.sql; tests/cloud-sync/stock-lots*.test.mjs; documentación local.

## FORBIDDEN_FILES
laboratorio/**, migraciones 0001..0029, tests existentes (assertions/expectativas), secrets, archivos fuera del directorio actual.
