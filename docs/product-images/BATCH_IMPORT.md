# Fotos por lote en CANON

Inventario → Cargar fotos acepta hasta 500 JPEG/PNG/WebP o un JSON versión 1 con `entries: [{codes: ["04692485"], image: "data:image/jpeg;base64,..."}]`. El nombre de cada foto debe ser un código exacto del producto, sin extensión. Los códigos siempre son texto. Nunca se vincula por nombre. Códigos ambiguos, productos repetidos, productos ausentes y fotos existentes se presentan en la vista previa; solo las filas Listas se guardan. Reemplazar requiere seleccionar de nuevo el lote.

Este catálogo visual vive en IndexedDB del dispositivo y origen, separado por promoción CANON. No sincroniza por el backend ni forma parte del backup comercial. Exportar lote permite respaldarlo y llevarlo a otro dispositivo. Deshacer restaura una vez el catálogo anterior. Borrar los datos del navegador elimina estas fotos; exportar antes.

READS: códigos y nombres actuales, imagen existente, permisos, promoción CANON. WRITES: únicamente la base IndexedDB `nuevo-amanecer-product-images-v1`. DOM: modal de fotos, tarjetas POS, carrito e inventario. No modifica productos, precios, stock, caja, ventas, códigos ni comandos CANON. Mantiene el overlay de imágenes existente como alternativa cuando no hay foto importada. Las escrituras verifican lectura posterior y comparan el registro anterior dentro de la transacción para evitar sobrescrituras entre pestañas.

Fotos individuales se convierten a JPEG de hasta 768 px; límite de 180000 caracteres por foto y 20 MB por catálogo. JSON exportado preserva bytes, valida formato y decodificación. La tabla usa textContent. El mismo módulo se incluye en el shell offline.

La descarga de las fotos de CasaMarket requiere una sesión autenticada vigente; este cambio no contiene fotos ni credenciales de CasaMarket.

## Sincronización con el servidor (miniaturas)

Solo el dispositivo propietario con sesión y permisos de importación puede subir o borrar fotos. Se conserva una miniatura por producto existente: máximo 60 000 caracteres por imagen, 2000 productos, 40 000 000 caracteres de fragmentos y 600 escrituras aceptadas por dispositivo por hora; las subidas sin cambios no cuentan. El cliente reduce a 320 px y, si hace falta, a 240 px.

El borrado explícito elimina metadatos y fragmentos. El manifiesto omite productos eliminados y cada escritura del propietario limpia hasta 50 imágenes huérfanas. Los backups lógicos excluyen imágenes y contadores de tasa; las fotos pueden volver a subirse desde el dispositivo o un lote JSON.

Al guardar un lote con sesión en la nube, cada foto se convierte en miniatura JPEG (máx. 320 px, ~10–60 KB) y se sube a `POST /auth/product-images` (solo aparatos con rol dueño = permiso `importar`). Cualquier sesión válida lee `GET /auth/product-images?since=<versión>` (manifiesto con `etag` por producto) y `GET /auth/product-images/item?product_id=…|code=…&v=<etag>`. Las miniaturas se descargan solo cuando una tarjeta las pide (máx. 3 en paralelo) y quedan en la IndexedDB `nuevo-amanecer-product-images-remote-v1`; la foto local del equipo siempre tiene prioridad. «Subir fotos de este equipo al servidor» (en Cargar fotos) sube una vez las fotos locales existentes.

Almacenamiento: tabla existente `pos_settings` (migración 0024), claves `internal:img:m:<hash>` (metadatos) e `internal:img:c:<hash>:<etag8>:<n>` (fragmentos de 7000 caracteres). No requiere migración ni bindings nuevos. Las claves `internal:` no aparecen en `/settings`.
