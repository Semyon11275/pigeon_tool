'use strict';
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
let passed=0;async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
const script=name=>fs.readFileSync(path.join(__dirname,'../extension',name),'utf8');
function fixture(host,project=false){
 let handler,mutation; const loc={href:'https://'+host+'/project/1',hostname:host};
 let images=[];
 function img(url,attrs={}){return {tagName:'IMG',src:url,currentSrc:url,naturalWidth:800,naturalHeight:600,alt:'Artwork',getAttribute:k=>attrs[k] || '',closest:selector=>selector.includes('/pin/')?{href:'https://www.pinterest.com/pin/123/'}:project && /project-module|work-content/.test(selector)?{}:null};}
 const doc={title:'Project',documentElement:{},querySelectorAll:s=>s==='img'?images:[]};
 const ctx={window:{},location:loc,document:doc,URL,Map,Set,Blob,AbortSignal,setTimeout,clearTimeout,MutationObserver:class{constructor(cb){mutation=cb;}observe(){}disconnect(){}},chrome:{runtime:{onMessage:{addListener:f=>handler=f}}},fetch:async()=>({ok:true,headers:{get:()=> 'image/png'},body:new ReadableStream({start(controller){controller.enqueue(Buffer.from('image bytes'));controller.close();}})}),FileReader:class{async readAsDataURL(blob){this.result='data:image/png;base64,'+Buffer.from(await blob.arrayBuffer()).toString('base64');this.onload();}}};
 vm.runInNewContext(script('content.js'),ctx);
 return {ctx,loc,img,setImages:x=>{images=x;},request:msg=>new Promise(resolve=>handler(msg,{},resolve)),mutate:()=>mutation()};
}
(async()=>{
 await test('Pinterest preserves Pin source and groups actual size variants',async()=>{
  const f=fixture('www.pinterest.com');f.setImages([f.img('https://i.pinimg.com/236x/ab/img.jpg'),f.img('https://i.pinimg.com/originals/ab/img.jpg')]);
  const r=await f.request({type:'PIGEON_COLLECT'});assert.equal(r.items.length,2);assert.equal(r.items[0].pageUrl,'https://www.pinterest.com/pin/123/');assert.equal(r.items[0].assetId,r.items[1].assetId);
 });
 for(const host of ['www.behance.net','www.zcool.com.cn']) await test(host+' project scope and stable discovery order',async()=>{
   const f=fixture(host,true);f.setImages([f.img('https://cdn.example/1.jpg'),f.img('https://cdn.example/2.jpg')]);
   const first=await f.request({type:'PIGEON_WATCH',enabled:true});assert.equal(first.projectAvailable,true);assert.equal(first.watching,true);
   f.setImages([f.img('https://cdn.example/3.jpg')]);f.mutate();await new Promise(r=>setTimeout(r,400));
   const second=await f.request({type:'PIGEON_COLLECT'});assert.equal(second.items.map(x=>x.srcUrl).join(),['1','2','3'].map(n=>'https://cdn.example/'+n+'.jpg').join());
   const stop=await f.request({type:'PIGEON_WATCH',enabled:false});assert.equal(stop.watching,false);
   f.loc.href='https://'+host+'/project/2';assert.equal((await f.request({type:'PIGEON_COLLECT'})).items.length,1);
 });
 await test('browser download accepts only collected image URLs',async()=>{
   const f=fixture('www.behance.net');f.setImages([f.img('https://cdn.example/1.jpg')]);await f.request({type:'PIGEON_COLLECT'});
   const good=await f.request({type:'PIGEON_FETCH_IMAGE',url:'https://cdn.example/1.jpg'});assert.equal(good.ok,true);assert.equal(Buffer.from(good.data,'base64').toString(),'image bytes');
   assert.equal((await f.request({type:'PIGEON_FETCH_IMAGE',url:'https://uncollected.invalid/a.jpg'})).ok,false);
 });
 await test('real background -> real HTTP reservation and browser byte protocol',async()=>{
   const {createBridgeServer}=require('../lib/bridge-server');const token='a'.repeat(48);let root='A',bound,received;
   const bridge=createBridgeServer({token,getInfo:()=>({version:'test',library:root}),listFolders:async()=>[],saveItems:async payload=>{
     if(!payload.items.length){bound=root;root='B';return{results:[],taskId:'AABBCCDDEEFF1122',library:bound};}
     assert.equal(payload.taskId,'AABBCCDDEEFF1122');received=payload;return{results:payload.items.map(it=>({ok:true,srcUrl:it.srcUrl})),taskId:payload.taskId,library:bound};
   }});
   const listening=await bridge.start();assert(listening);const storage={token,port:listening.port};let route;
   try {
     const chrome={runtime:{onInstalled:{addListener(){}},onMessage:{addListener:fn=>route=fn}},contextMenus:{onClicked:{addListener(){}},removeAll(cb){cb();},create(){}},notifications:{create(){}},storage:{local:{get:async keys=>typeof keys==='string'?{[keys]:storage[keys]}:Object.fromEntries(keys.map(k=>[k,storage[k]])),set:async v=>Object.assign(storage,JSON.parse(JSON.stringify(v)))}},tabs:{sendMessage:async()=>({ok:true,data:Buffer.from('png bytes').toString('base64'),mime:'image/png'})}};
     vm.runInNewContext(script('background.js'),{chrome,fetch,console,URL,AbortSignal});
     const response=await new Promise(resolve=>route({type:'SAVE_TASK',items:[{srcUrl:'https://cdn.example/a.png'}],browserDownload:true,tabId:9},{},resolve));assert.equal(response.ok,true);
     for(let i=0;i<100 && storage.taskState?.status!=='done';i++)await new Promise(r=>setTimeout(r,20));
     assert.equal(storage.taskState.status,'done');assert.equal(storage.taskState.saved,1);assert.equal(storage.taskState.library,'A');assert.equal(received.items[0].mime,'image/png');assert.equal(Buffer.from(received.items[0].data,'base64').toString(),'png bytes');
     assert.equal((await new Promise(resolve=>route({type:'SAVE',items:[]},{tab:{id:9}},resolve))).ok,false);
   }finally{bridge.stop();}
 });
 console.log('CAPTURE_V2_SUMMARY PASS '+passed);
})().catch(e=>{console.error(e);process.exitCode=1;});
