'use strict';
const assert=require('node:assert/strict');
const {readClipboard}=require('../lib/clipboard');
const nativeImage={createEmpty:()=>({isEmpty:()=>true}),createFromBuffer:b=>({isEmpty:()=>false,data:b})};
(async()=>{
 const blob=(v)=>new Blob([v]);
 const result=await readClipboard({read:async()=>[{types:['text/plain','text/html','image/png'],getType:async type=>({'text/plain':blob('hello'),'text/html':blob('<b>hello</b>'),'image/png':blob('PNG')})[type]}]},nativeImage);
 assert.equal(result.text,'hello');assert.equal(result.html,'<b>hello</b>');assert.equal(result.image.data.toString(),'PNG');
 const empty=await readClipboard({read:async()=>[]},nativeImage);assert.equal(empty.image.isEmpty(),true);assert.equal(empty.text,'');
 await assert.rejects(()=>readClipboard({read:async()=>{throw Error('clipboard unavailable');}},nativeImage),/unavailable/);
 console.log('CLIPBOARD_ASYNC PASS snapshot text/html/image, empty, failure');
})().catch(e=>{console.error(e);process.exitCode=1});
