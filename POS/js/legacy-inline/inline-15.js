
// Seguridad: descripciones, categorías y notas de gastos se muestran como texto.
gasRender=function(){
  const rows=gasGetList(),total=rows.reduce((sum,expense)=>sum+_naNumber(expense.monto),0),largest=rows.length?Math.max(...rows.map(expense=>_naNumber(expense.monto))):0,categoryTotals={};
  rows.forEach(expense=>{const category=String(expense.cat||'Otro');categoryTotals[category]=(categoryTotals[category]||0)+_naNumber(expense.monto);});
  const topCategory=Object.entries(categoryTotals).sort((a,b)=>b[1]-a[1])[0];
  [['gasS0',`S/${total.toFixed(0)}`],['gasS1',rows.length],['gasS2',`S/${largest.toFixed(0)}`],['gasS3',topCategory?topCategory[0].substring(0,8):'—']].forEach(([id,value])=>{const element=document.getElementById(id);if(element)element.textContent=String(value);});
  const container=document.getElementById('gasContent');
  if(!container)return;
  container.replaceChildren();
  if(!rows.length){
    const empty=_naSecAppend(container,'div','empty-state');
    _naSecAppend(empty,'div','ei','🧾');
    _naSecAppend(empty,'p','','Sin gastos en este período');
    return;
  }
  const byDate={};
  rows.forEach(expense=>{const date=String(expense.fecha||'Sin fecha');if(!byDate[date])byDate[date]=[];byDate[date].push(expense);});
  Object.entries(byDate).sort((a,b)=>b[0].localeCompare(a[0])).forEach(([date,expenses])=>{
    const subtotal=expenses.reduce((sum,expense)=>sum+_naNumber(expense.monto),0),header=_naSecAppend(container,'div');
    header.style.cssText='font-size:10px;font-weight:800;color:var(--slate);text-transform:uppercase;letter-spacing:.06em;margin:6px 0 5px;display:flex;justify-content:space-between';
    _naSecAppend(header,'span','',date===obtenerHoy()?'Hoy':date);
    const subtotalNode=_naSecAppend(header,'span','',`-${fmt(subtotal)}`);
    subtotalNode.style.color='var(--red)';
    expenses.forEach(expense=>{
      const card=_naSecAppend(container,'div','gasto-card egreso');
      _naSecAppend(card,'div','gasto-icon','').innerHTML=CAT_ICONS[expense.cat]||'<i class="na-ic na-ic-clip" aria-hidden="true"></i>';
      const info=_naSecAppend(card,'div','gasto-info');
      _naSecAppend(info,'div','gasto-desc',expense.desc||'Gasto');
      const meta=_naSecAppend(info,'div','gasto-meta');
      _naSecAppend(meta,'span','gasto-cat',expense.cat||'Otro');
      _naSecAppend(meta,'span','',` ${expense.metodo||''}`).insertAdjacentHTML('afterbegin','<i class="na-ic na-ic-card" aria-hidden="true"></i>');
      if(expense.nota)_naSecAppend(meta,'span','',expense.nota);
      _naSecAppend(card,'div','gasto-monto',`-${fmt(expense.monto)}`);
    });
  });
};
