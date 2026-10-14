import lotCore from '../../../POS/js/inventory/stock-lots.js';
export const lotsCore = lotCore;
const schemaCache = new WeakMap();
export function rememberLotSchema(db, schema) {
  if (schemaCache.get(db)?.ready === true) return;
  const ready = schema.has('canonical_stock_lots') && schema.has('canonical_stock_lot_effects');
  schemaCache.set(db, { ready, expiresAt: ready ? Infinity : Date.now() + 60000 });
}
export async function lotsReady(db) {
  const cached = schemaCache.get(db);
  if (cached && Date.now() < cached.expiresAt) return cached.ready;
  const row = await db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name IN ('canonical_stock_lots','canonical_stock_lot_effects')").first();
  const ready = schemaCache.get(db)?.ready === true || Number(row?.n) === 2;
  schemaCache.set(db, { ready, expiresAt: ready ? Infinity : Date.now() + 60000 });
  return ready;
}
export async function productLots(db, promotion, product) {
  return (await db.prepare('SELECT lot_id,lot_code,expiry_date,quantity,received_at FROM canonical_stock_lots WHERE promotion_id=?1 AND product_id=?2 ORDER BY expiry_date,received_at,lot_id').bind(promotion,product).all()).results || [];
}
export async function productsLots(db,promotion,ids){
  const rows=(await db.prepare(`SELECT product_id,lot_id,lot_code,expiry_date,quantity,received_at FROM canonical_stock_lots
    WHERE promotion_id=?1 AND product_id IN (SELECT value FROM json_each(?2)) ORDER BY expiry_date,received_at,lot_id`)
    .bind(promotion,JSON.stringify(ids)).all()).results||[];
  const map=new Map();for(const row of rows){const list=map.get(row.product_id)||[];list.push(row);map.set(row.product_id,list);}return map;
}
export function lotError(error) {
  const code = String(error?.message || '');
  return code === 'EXPIRED_LOTS_CONFIRMATION_REQUIRED' ? 'expired_lots_confirmation_required' : code === 'INSUFFICIENT_PROJECTED_STOCK' ? 'insufficient_stock' : 'invalid_lot_state';
}
export async function saleLotReceipt(db,body){
  if(!await lotsReady(db))return{};
  const rows=(await db.prepare(`SELECT e.product_id,e.lot_id,-e.quantity AS quantity,e.expired_confirmed,l.expiry_date
    FROM canonical_stock_lot_effects e LEFT JOIN canonical_stock_lots l
      ON l.promotion_id=e.promotion_id AND l.product_id=e.product_id AND l.lot_id=e.lot_id
    WHERE e.promotion_id=?1 AND e.sale_id=?2 AND e.operation_id=?3 AND e.quantity<0 ORDER BY e.product_id,e.lot_id`)
    .bind(body.promotion_id,body.sale_id,body.operation_id).all()).results||[];
  return {
    ...(rows.some(r=>r.lot_id)?{lot_allocations:rows.map(({product_id,lot_id,quantity})=>({product_id,lot_id,quantity}))}:{}),
    ...(rows.some(r=>r.expiry_date<lotsCore.businessDate(new Date().toISOString())&&Number(r.expired_confirmed)===0)?{expired_lots_unconfirmed:true}:{})
  };
}
// All statements returned here execute in the caller's stock CAS batch. An
// assertion after each mutable lot verifies that no stale plan can commit.
export function effectStatements(db, body, allocations, deltaSign, rows, token, saleId = null) {
  const statements = [], byId = new Map(rows.map(r => [r.lot_id,r]));
  for (const [index,a] of allocations.entries()) {
    if (a.lot_id) {
      const before = Number(byId.get(a.lot_id)?.quantity);
      statements.push(db.prepare(`UPDATE canonical_stock_lots SET quantity=ROUND(quantity+?1,9)
        WHERE promotion_id=?2 AND product_id=?3 AND lot_id=?4 AND quantity=?5 AND quantity+?1>=-0.000000001`)
        .bind(deltaSign*a.quantity,body.promotion_id,body.product_id,a.lot_id,before));
      statements.push(db.prepare('INSERT INTO canonical_assertions(assertion_id,ok) VALUES(?1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)').bind(token+':lot:'+index));
    }
    statements.push(db.prepare(`INSERT INTO canonical_stock_lot_effects
      (promotion_id,product_id,operation_id,lot_id,quantity,sale_id,created_at,expired_confirmed) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
      .bind(body.promotion_id,body.product_id,body.operation_id,a.lot_id,deltaSign*a.quantity,saleId,body.created_at,body.allow_expired_lots===true?1:0));
  }
  return statements;
}
export function receiptStatements(db, body) {
  const statements=[];
  for (const [index,r] of (body.lots || []).entries()) {
    const id=body.operation_id+':lot:'+index;
    statements.push(db.prepare(`INSERT INTO canonical_stock_lots
      (promotion_id,product_id,lot_id,lot_code,expiry_date,quantity,received_at,receipt_operation_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)`)
      .bind(body.promotion_id,body.product_id,id,r.lot_code,r.expiry_date,r.quantity,new Date(body.created_at).toISOString(),body.operation_id));
    statements.push(db.prepare(`INSERT INTO canonical_stock_lot_effects
      (promotion_id,product_id,operation_id,lot_id,quantity,created_at) VALUES(?1,?2,?3,?4,?5,?6)`)
      .bind(body.promotion_id,body.product_id,body.operation_id,id,r.quantity,body.created_at));
  }
  return statements;
}
// Bound to the durable annulment claim, never accepted as arbitrary client lot ids.
export async function annulAllocations(db, body) {
  const claim=await db.prepare("SELECT sale_id FROM pos_sale_annulments WHERE operation_id=?1 AND promotion_id=?2 AND status='en_curso'").bind(body.return_sale_operation,body.promotion_id).first();
  if (!claim || !body.operation_id.startsWith(body.return_sale_operation+':inv:')) throw new Error('INVALID_LOT_RETURN');
  const original=(await db.prepare(`SELECT lot_id,-quantity AS quantity FROM canonical_stock_lot_effects
    WHERE promotion_id=?1 AND sale_id=?2 AND product_id=?3 AND quantity<0 ORDER BY lot_id`).bind(body.promotion_id,claim.sale_id,body.product_id).all()).results || [];
  if (original.length && Math.abs(original.reduce((s,a)=>s+a.quantity,0)-body.quantity)>1e-8) throw new Error('INVALID_LOT_RETURN');
  return original;
}
