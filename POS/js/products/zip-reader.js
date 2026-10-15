(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;else root.NuevoAmanecerZipReader=api;})(globalThis,function(root){
  'use strict';
  const MAX_IMAGES=500,MAX_ENTRY_BYTES=15*1024*1024;
  const isImage=name=>!name.split(/[\\/]/).some(part=>part.startsWith('.')||part==='__MACOSX')&&/\.(jpe?g|png|webp)$/i.test(name);
  async function read(input){
    const bytes=new Uint8Array(input instanceof ArrayBuffer?input:await input.arrayBuffer()),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const check=(offset,size)=>{if(offset<0||offset+size>bytes.length)throw Error('ZIP inválido');};
    let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(view.getUint32(i,true)===0x06054b50&&i+22+view.getUint16(i+20,true)===bytes.length){end=i;break;}}
    if(end<0)throw Error('ZIP inválido');
    const count=view.getUint16(end+10,true),centralSize=view.getUint32(end+12,true),start=view.getUint32(end+16,true);
    if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||view.getUint16(end+8,true)!==count||count===65535||start===0xffffffff||start+centralSize!==end)throw Error('ZIP multipartes o ZIP64 no compatible');
    check(start,centralSize);let offset=start;const entries=[];
    for(let i=0;i<count;i++){
      check(offset,46);if(view.getUint32(offset,true)!==0x02014b50)throw Error('ZIP inválido');
      const flags=view.getUint16(offset+8,true),method=view.getUint16(offset+10,true),packed=view.getUint32(offset+20,true),size=view.getUint32(offset+24,true),nameSize=view.getUint16(offset+28,true),extra=view.getUint16(offset+30,true),comment=view.getUint16(offset+32,true),local=view.getUint32(offset+42,true);
      check(offset+46,nameSize+extra+comment);const name=new TextDecoder().decode(bytes.subarray(offset+46,offset+46+nameSize));offset+=46+nameSize+extra+comment;
      if(name.endsWith('/')||!isImage(name))continue;
      if(size>MAX_ENTRY_BYTES)throw Error('Imagen ZIP mayor de 15 MB');
      if(entries.length>=MAX_IMAGES)throw Error('Máximo 500 imágenes por ZIP');
      if(flags&1||![0,8].includes(method))throw Error('Método ZIP no compatible');
      check(local,30);if(view.getUint32(local,true)!==0x04034b50||view.getUint16(local+8,true)!==method||view.getUint16(local+6,true)!==flags)throw Error('ZIP inválido');
      const nameLength=view.getUint16(local+26,true),dataStart=local+30+nameLength+view.getUint16(local+28,true);check(local+30,nameLength);check(dataStart,packed);
      if(dataStart+packed>start||new TextDecoder().decode(bytes.subarray(local+30,local+30+nameLength))!==name)throw Error('ZIP inválido');
      entries.push({name,method,packed,size,dataStart});
    }
    if(offset!==end)throw Error('ZIP inválido');
    const result=[];
    for(const entry of entries){
      let data=bytes.slice(entry.dataStart,entry.dataStart+entry.packed);
      if(entry.method===8){
        if(!root.DecompressionStream)throw Error('Este navegador no admite ZIP comprimido');
        let stream;try{stream=new root.Blob([data]).stream().pipeThrough(new root.DecompressionStream('deflate-raw'));}catch{throw Error('Este navegador no admite ZIP comprimido');}
        const reader=stream.getReader(),chunks=[];let total=0;
        try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>entry.size||total>MAX_ENTRY_BYTES)throw Error('Imagen ZIP mayor del tamaño declarado');chunks.push(value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
        data=new Uint8Array(total);let cursor=0;for(const chunk of chunks){data.set(chunk,cursor);cursor+=chunk.length;}
      }
      if(data.length!==entry.size)throw Error('Tamaño ZIP inválido');
      const type=/\.png$/i.test(entry.name)?'image/png':/\.webp$/i.test(entry.name)?'image/webp':'image/jpeg';
      result.push({name:entry.name,size:data.length,type,arrayBuffer:async()=>data.buffer});
    }
    return result;
  }
  return Object.freeze({read,isImage,MAX_IMAGES,MAX_ENTRY_BYTES});
});
