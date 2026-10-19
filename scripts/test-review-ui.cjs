const {app}=require('electron'),fs=require('fs'),path=require('path');
const repo=path.resolve(__dirname,'..');
if(!process.env.PIGEON_TEST_TMP)throw Error('PIGEON_TEST_TMP required');
const base=fs.mkdtempSync(path.join(process.env.PIGEON_TEST_TMP,'ui-'));
for(const d of ['userdata','temp','library/images/ABC.info'])fs.mkdirSync(path.join(base,d),{recursive:true});
app.setPath('userData',path.join(base,'userdata'));app.setPath('temp',path.join(base,'temp'));
fs.writeFileSync(path.join(base,'userdata/config.json'),JSON.stringify({libraries:[],settings:{updates:{checkOnStart:false},ai:{enabled:false},capture:{enabled:false},globalHotkey:{enabled:false},autoImport:{enabled:false,folders:[]}}}));
fs.writeFileSync(path.join(base,'library/metadata.json'),JSON.stringify({folders:[],smartFolders:[],tagsGroups:[],quickAccess:[]}));
fs.writeFileSync(path.join(base,'library/images/ABC.info/媒体.mp4'),'0123456789');
let first=true;
const timer=setTimeout(()=>{console.error('UI timeout');app.exit(1)},30000);
app.on('browser-window-created',(_e,win)=>{
 if(!first)return;first=false;
 win.webContents.once('did-finish-load',async()=>{try{
  await new Promise(r=>setTimeout(r,1000));win.setSize(1000,650);
  const result=await win.webContents.executeJavaScript(`(async()=>{
   await window.pigeon.library.open(${JSON.stringify(path.join(base,'library'))});
   const url='pigeon://item/ABC/'+encodeURIComponent('媒体.mp4');
   const tail=await fetch(url,{headers:{Range:'bytes=-3'}}),tailText=await tail.text();
   const bad=await fetch(url,{headers:{Range:'bytes=10-'}});
   const escape=await fetch('pigeon://item/ABC/..%5c..%5cmetadata.json');
   showMenu(innerWidth-5,50,[{label:'普通操作',action:()=>{}},{label:'子菜单',sub:[{label:'子项',action:()=>{}}]}]);
   const menu=document.querySelector('#menu-layer .menu'),rows=menu.querySelectorAll('.mi');
   const arrows=menu.querySelectorAll('.arrow').length;
   rows[1].dispatchEvent(new MouseEvent('mouseenter'));
   const sub=document.querySelector('.submenu').getBoundingClientRect(),parent=menu.getBoundingClientRect();
   rows[0].dispatchEvent(new MouseEvent('mouseenter'));
   return {suffix:tail.status===206&&tailText==='789',invalid:bad.status===416&&bad.headers.get('Content-Range')==='bytes */10',escape:escape.status===403,arrows:arrows===1,submenuLeft:sub.right<=parent.left&&sub.left>=0,staleRemoved:!document.querySelector('.submenu')};
  })()`);
  console.log('REVIEW_UI',JSON.stringify(result));
  if(Object.values(result).some(v=>v!==true))throw Error('UI/protocol regression');
  clearTimeout(timer);app.exit(0);
 }catch(e){console.error(e);app.exit(1)}});
});
require(repo+'/main.js');
