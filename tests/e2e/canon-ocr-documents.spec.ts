import {test,expect} from '@playwright/test';
import path from 'node:path';
for(const file of ['purchase.pdf','purchase.docx','purchase.png','scan.pdf','hybrid.pdf','table.docx'])test('automatic verification '+file,async({page})=>{
 test.setTimeout(120000);
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.setViewportSize({width:390,height:844});await page.goto('/index.html');
 await page.waitForFunction(()=>_naFreeSaleShortcutState.ready);
 await page.evaluate(()=>{productos=[{id:987654,name:'PRODUCTO PRUEBA',sku:'7751234567890',barcode:'7751234567890',cat:'snacks',precio:5,costo:3.5,stock:8,stockMin:3,unidad:'unidad',icon:'📦'}];window.NA_MENU_NAVIGATION.navigate('pageInventario');invRender();});
 const before=await page.evaluate(()=>JSON.stringify(productos));
 await page.locator('#pageInventario .inv-secondary>summary').click();await page.getByRole('button',{name:'OCR compras',exact:true}).click();
 await expect(page.getByRole('button',{name:'Tomar foto',exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Subir PDF o documento',exact:true})).toBeVisible();
 await page.locator(file.endsWith('.png')?'#ocrPurchaseFile':'#ocrPurchaseDocument').setInputFiles(path.resolve('tests/ocr/fixtures',file));
 await expect(page.locator('#mOcrPurchaseReview')).toHaveClass(/open/,{timeout:100000});
 await expect(page.locator('#ocrPurchaseReviewRows .ocr-review-row')).toHaveCount(file==='purchase.pdf'?2:1);
 await expect(page.locator('#ocrPurchaseRawText')).toContainText('PRODUCTO');
 expect(await page.evaluate(()=>JSON.stringify(productos))).toBe(before);
 await page.locator('#ocrPurchaseApply').click();
 expect(await page.evaluate(()=>JSON.stringify(productos))).toBe(before);
 await expect(page.locator('#ocrReviewStatus')).toContainText('Confirma o descarta');
});

test('DOCX table keeps product quantity and cost on the same line',async({page})=>{
 await page.goto('/index.html');
 // OCR se carga a pedido (P0-2): igual que el botón "OCR compras".
 await page.evaluate(()=>NuevoAmanecerLazyAssets.load('ocr'));
 const rows=await page.evaluate(async bytes=>{const file=new File([new Uint8Array(bytes)],'table.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});const result=await extractPurchaseDocument(file);return parsePurchaseText(result.rawText);},Array.from(await (await import('node:fs/promises')).readFile('tests/ocr/fixtures/table.docx')));
 expect(rows).toHaveLength(1);expect(rows[0].qty).toBe(2);expect(rows[0].unitPrice).toBe(3.5);
});
