import {test,expect,type Page,type Locator} from '@playwright/test';
test.use({serviceWorkers:'block'});
// Valid synthetic 1px PNG, shared with product-image-batch.spec.ts.
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg2LIAAAIMAVUeX9q0AAAAAElFTkSuQmCC';
const product=(id:number,name:string,sku:string,barcode=sku)=>({id,name,sku,barcode,codigosAlternativos:[],precio:2,costo:1,stock:20,stockMin:2,cat:'abarrotes',icon:'📦',unidad:'unidad',venc:'',imagen:''});
const catalog=[product(99001,'Ácido fólico 5 mg','001'),product(99002,'Jabón neutro','002'),product(99003,'Duplicado A','003','009'),product(99004,'Duplicado B','004','009')];
const entry=(filename:string,codes=[filename.replace(/\.[^.]+$/,'')])=>({filename,codes,image});

async function setup(page:Page,initialRole:'owner'|'empleado'='owner'){
  let role=initialRole,failNext=false,version=0;
  const posts:any[]=[],store=new Map<string,any>();
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.hostname==='127.0.0.1')return route.continue();
    if(url.hostname!=='permissions.test')return route.abort();
    let body:any={};
    if(url.pathname==='/auth/me')body={pos_role:role,owner_pin_set:true,roles_ready:true,device_id:'review-'+role};
    else if(url.pathname==='/auth/product-images'&&request.method()==='POST'){
      const payload=request.postDataJSON();posts.push(payload);
      if(role!=='owner')return route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'forbidden_role'})});
      if(failNext){failNext=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'synthetic_unavailable'})});}
      expect(Object.keys(payload).sort()).toEqual(['codes','image','product_id']);
      expect(payload.image).toMatch(/^data:image\/(webp|jpeg);base64,/);
      expect(Buffer.from(payload.image.split(',')[1],'base64').length).toBeLessThanOrEqual(40000);
      const etag='review-'+(++version);store.set(payload.product_id,{...payload,etag});body={status:'ok',etag};
    }else if(url.pathname==='/auth/product-images/item')body=store.get(url.searchParams.get('product_id')!);
    else if(url.pathname==='/auth/product-images')body={status:'ok',version:String(version),images:[...store.values()].map(({image,...record})=>record)};
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body||{})});
  });
  await page.goto('/index.html');
  await page.evaluate(role=>{localStorage.setItem('na_cloud_sync_credentials',JSON.stringify({endpoint:'https://permissions.test',token:'synthetic-review'}));localStorage.setItem('na_pos_role_v1',JSON.stringify({role}));},role);
  await page.reload();
  await page.waitForFunction(role=>{const r=(window as any).NA_ROLES;return r?.role===role&&r.confirmed;},role);
  await page.waitForFunction('_naFreeSaleShortcutState.ready');
  await page.waitForFunction(()=>!!(window as any).NuevoAmanecerImageSync);
  await page.evaluate(products=>{
    const w=window as any;w.eval(`productos=${JSON.stringify(products)}`);
    w.NuevoAmanecerCanonical={enabled:()=>true,sourceState:()=>({cache:{promotion_id:'image-review-test'}}),snapshot:()=>{throw Error('Photo lookup copied full CANON history');}};
    w._naAuthorize=()=>true;w.securityIsLocked=()=>false;
    for(const name of ['posRender','invRender','posUpdateCart'])if(typeof w[name]==='function')w[name]();
  },catalog);
  return {posts,store,fail:()=>{failNext=true;},setRole:async(next:'owner'|'empleado')=>{role=next;await page.evaluate(()=>(window as any).NA_ROLES.refresh());}};
}
async function open(page:Page){
  await page.evaluate(()=>(window as any).NuevoAmanecerImageBatch.open());
  await expect(page.locator('#productImageBatchModal')).toBeVisible();
  await expect(page.locator('#productImageBatchStatus')).toContainText('Selecciona');
}
async function select(page:Page,entries:ReturnType<typeof entry>[]){
  await page.locator('#productImageBatchFiles').setInputFiles({name:'revision.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,entries}))});
  await expect(page.locator('#productImageBatchReview')).toBeVisible();
  await expect(page.locator('.image-review-card')).toHaveCount(entries.length);
}
async function touchable(locator:Locator){
  await locator.evaluate(node=>node.scrollIntoView({block:'center'}));
  expect(await locator.evaluate(node=>{const box=node.getBoundingClientRect(),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);return box.height>=44&&(hit===node||node.contains(hit));})).toBe(true);
}
for(const width of [390,768,1366])for(const dark of [false,true])test(`revisión de fotos ${width}px tema ${dark?'oscuro':'claro'} exige confirmación explícita`,async({page})=>{
  await page.setViewportSize({width,height:900});const f=await setup(page);
  await page.evaluate(dark=>document.body.classList.toggle('dark',dark),dark);
  const protectedLayout=()=>page.evaluate(()=>['pagePOS','pageMenu'].map(id=>{const node=document.getElementById(id)!;return {id,html:node.innerHTML,className:node.className,style:node.getAttribute('style'),width:node.getBoundingClientRect().width};}));
  const beforeLayout=await protectedLayout();await open(page);await select(page,[entry('ACIDO_FOLICO_5_MG.png'),entry('xyz.png')]);
  const suggested=page.locator('.image-review-card').first(),missing=page.locator('.image-review-card').nth(1);
  await expect(suggested.locator('.image-review-suggestion')).toHaveText('Sugerencia: Ácido fólico 5 mg (100%)');
  await expect(missing.locator('.image-review-suggestion')).toHaveText('sin sugerencia');
  await expect(missing.locator('.image-review-confirm')).toHaveCount(0);
  await expect(suggested.locator('img')).toBeVisible();
  await expect.poll(()=>suggested.locator('img').evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(1);
  await expect(missing.locator('.image-review-save')).toBeDisabled();
  expect(f.posts).toHaveLength(0);expect(await protectedLayout()).toEqual(beforeLayout);
  // Every card stays inside the modal at all three widths, including long names.
  expect(await page.locator('#productImageBatchReview').evaluate(node=>{const modal=node.closest('.modal')!,bounds=modal.getBoundingClientRect();return modal.scrollWidth<=modal.clientWidth+1&&[...node.querySelectorAll('article,input,button')].every(el=>{const rect=el.getBoundingClientRect();return rect.left>=bounds.left&&rect.right<=bounds.right;});})).toBe(true);
  const before=await page.evaluate('JSON.stringify(productos)');
  await touchable(suggested.locator('.image-review-confirm'));
  await touchable(missing.locator('.image-review-search'));
  await suggested.locator('.image-review-confirm').click();
  await expect(page.locator('#productImageBatchStatus')).toContainText('Foto guardada en el servidor para Ácido fólico 5 mg');
  expect(f.posts).toHaveLength(1);expect(f.posts[0].product_id).toBe('99001');expect(f.posts[0].codes).toEqual(['001']);
  expect(await page.evaluate('JSON.stringify(productos)')).toBe(before);
});
test('búsqueda manual y código duplicado guardan solo el ID elegido',async({page})=>{
  const f=await setup(page);await open(page);await select(page,[entry('xyz.png'),entry('009.png',['009'])]);
  const manual=page.locator('.image-review-card').first();await manual.locator('input').fill('JABON');
  await expect(manual.locator('.image-review-option')).toHaveCount(1);await manual.locator('.image-review-option').click();
  expect(f.posts).toHaveLength(0);await manual.locator('.image-review-save').click();
  await expect(page.locator('#productImageBatchStatus')).toContainText('Jabón neutro');expect(f.posts[0].product_id).toBe('99002');
  const duplicate=page.locator('.image-review-card').first();await expect(duplicate.locator('.image-review-suggestion')).toHaveText('código duplicado: elegir producto');
  await expect(duplicate.locator('.image-review-confirm')).toHaveCount(0);await duplicate.locator('input').fill('009');
  await expect(duplicate.locator('.image-review-option')).toHaveCount(2);await duplicate.locator('.image-review-option').filter({hasText:'Duplicado B'}).click();
  expect(f.posts).toHaveLength(1);await duplicate.locator('.image-review-save').click();
  await expect(page.locator('#productImageBatchReview')).toBeHidden();expect(f.posts[1].product_id).toBe('99004');
  await expect.poll(()=>page.evaluate(()=>{const w=window as any;return w.NuevoAmanecerImageBatch.source(w.eval('productos[3]'));})).toMatch(/^data:image\//);
  expect(await page.evaluate(()=>{const w=window as any;return w.NuevoAmanecerImageBatch.source(w.eval('productos[2]'));})).toBeNull();
});
test('empleado no abre la lista; pérdida de rol limpia una revisión ya visible',async({page})=>{
  const f=await setup(page,'empleado');await page.evaluate(()=>(window as any).NuevoAmanecerImageBatch.open());
  await expect(page.locator('#productImageBatchModal')).toBeHidden();await expect(page.locator('#productImageBatchReview')).toBeHidden();
  await f.setRole('owner');await open(page);await select(page,[entry('acido folico 5 mg.png')]);
  await f.setRole('empleado');await expect(page.locator('#productImageBatchReview')).toBeHidden();
  await expect(page.locator('.image-review-card')).toHaveCount(0);await expect(page.locator('#productImageBatchModal')).toBeHidden();expect(f.posts).toHaveLength(0);
});
test('un error de subida conserva la foto para reintento y catálogo obsoleto bloquea el guardado',async({page})=>{
  const f=await setup(page);await open(page);await select(page,[entry('acido folico 5 mg.png')]);f.fail();
  await page.locator('.image-review-confirm').click();await expect(page.locator('.image-review-feedback')).toContainText('No se pudo guardar');
  await expect(page.locator('.image-review-card')).toHaveCount(1);expect(f.store.size).toBe(0);
  await page.locator('.image-review-confirm').click();await expect(page.locator('#productImageBatchReview')).toBeHidden();expect(f.store.size).toBe(1);
  await select(page,[entry('jabon neutro.png')]);await page.evaluate("productos[1].barcode='changed'");
  await page.locator('.image-review-confirm').click();await expect(page.locator('.image-review-feedback')).toContainText('El catálogo cambió');expect(f.posts).toHaveLength(2);
});
