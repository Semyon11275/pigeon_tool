'use strict';
const assert=require('node:assert/strict'),fs=require('fs-extra'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const keys=require('../lib/shortcuts');
const {chooseRelease,createUpdater}=require('../lib/updater');
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
function ps(script,args){return execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,script),...args],{windowsHide:true,encoding:'utf8',stdio:'pipe'});}
(async()=>{
const ctx={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/common.js'),'utf8'),ctx);
await test('selection preserves excluded and hidden items across merge',()=>{
 const m=new ctx.PigeonExt.Selection();m.merge([{srcUrl:'a'},{srcUrl:'b'}],true);m.toggle('b');m.merge([{srcUrl:'b'},{srcUrl:'c'}],false);
 assert.equal(m.selected().map(x=>x.id).join(),'a');m.selectVisible([m.byId.get('c')],true);assert.equal(m.selected().map(x=>x.id).join(),'a,c');
 const snapshot=m.selected();m.toggle('a');assert.equal(snapshot.length,2);assert.equal(m.selected().length,1);
});
await test('shortcut defaults, aliases and recording',()=>{assert.equal(keys.bindings().tag,'T');assert.equal(keys.fromEvent({key:' ',ctrlKey:false}),'Space');assert.equal(keys.fromEvent({key:'f',ctrlKey:true}),'Ctrl+F');});
await test('shortcut conflicts and reserved keys rejected',()=>{assert.throws(()=>keys.validate({tag:'Ctrl+F'}),/冲突/);assert.throws(()=>keys.validate({tag:'Escape'}),/保留/);assert.throws(()=>keys.validate({}, {capture:'T'}),/全局/);assert.throws(()=>keys.validate({}, {capture:'Ctrl+F'}),/冲突/);});
await test('shortcut scope, composing, repeats and disabled binding',()=>{assert.equal(keys.resolve({key:'ArrowLeft'}, {}, 'main'),null);assert.equal(keys.resolve({key:'ArrowLeft'}, {}, 'preview'),'previous');assert.equal(keys.resolve({key:'t',isComposing:true},{}),null);assert.equal(keys.resolve({key:'t',repeat:true},{}),null);assert.equal(keys.resolve({key:'t'},{tag:''}),null);assert.equal(keys.resolve({key:'t',altKey:true},{}),null);});
const bytes=Buffer.from('trusted-package'),digest=crypto.createHash('sha256').update(bytes).digest('hex');
const release={tag_name:'v1.0.0',body:'notes',assets:[{name:'Pigeon-1.0.0-win-x64.zip',browser_download_url:'https://github.com/Semyon11275/pigeon_tool/releases/download/v1.0.0/package.zip',size:bytes.length,digest:'sha256:'+digest}]};
await test('release selection rejects downgrades, untrusted source and missing hash',()=>{assert.equal(chooseRelease(release,'1.0.0'),null);assert.equal(chooseRelease({...release,prerelease:true},'0.9.0'),null);assert.throws(()=>chooseRelease({...release,assets:[{...release.assets[0],digest:null}]},'0.9.0'));assert.throws(()=>chooseRelease({...release,assets:[{...release.assets[0],browser_download_url:'https://evil.invalid/x'}]},'0.9.0'));});
await test('legacy GitHub Latest tags are skipped without errors',()=>{
 for(const tag of ['v0.8.0-demo-fix3','nightly','v0.9.4-beta.1','garbage']) assert.equal(chooseRelease({...release,tag_name:tag},'0.9.2'),null);
});
await test('real check state handles historical Latest without false failure',async()=>{
 const u=createUpdater({app:{getVersion:()=> '0.9.2',isPackaged:false},baseDir:process.env.PIGEON_TEST_TMP,canInstall:()=>false,fetchImpl:async()=>({ok:true,json:async()=>({...release,tag_name:'v0.8.0-demo-fix3'})})});
 const state=await u.check();assert.equal(state.status,'unpublished');assert.equal(state.error,'');assert.equal(state.available,null);
});
if(!process.env.PIGEON_TEST_TMP) throw Error('Set PIGEON_TEST_TMP to an isolated test directory');
await fs.ensureDir(process.env.PIGEON_TEST_TMP);const temp=await fs.mkdtemp(path.join(process.env.PIGEON_TEST_TMP,'features-'));
let bad=false;
const updater=createUpdater({app:{getVersion:()=> '0.9.0',isPackaged:false},baseDir:temp,canInstall:()=>false,fetchImpl:async url=>url.includes('api.github.com')?{ok:true,json:async()=>release}:{ok:true,body:(async function*(){yield bad?Buffer.from('bad'):bytes;})()}});
await test('download verifies hash and development install is blocked',async()=>{assert.equal((await updater.check()).status,'available');assert.equal((await updater.download()).status,'ready');await assert.rejects(()=>updater.install(),/开发环境/);bad=true;assert.equal((await updater.download()).status,'error');assert.equal(await fs.pathExists(path.join(temp,'updater/update.zip.part')),false);});
const src=path.join(temp,'中文路径 source'),out=path.join(temp,'中文路径 packages');await fs.outputFile(path.join(src,'Pigeon.exe'),'new exe');await fs.outputFile(path.join(src,'resources/app.asar'),'new app');await fs.outputFile(path.join(src,'resources/nested/new.bin'),'new file');await fs.outputFile(path.join(src,'data/private.txt'),'never packaged');await fs.outputFile(path.join(src,'dxcompiler.dll'),'runtime44');await fs.outputFile(path.join(src,'dxil.dll'),'runtime44');await fs.outputFile(path.join(src,'version'),'44.9.0');
ps('package-update.ps1',['-SourceDir',src,'-OutputDir',out,'-Version','1.0.0']);
const zip=path.join(out,'Pigeon-1.0.0-win-x64.zip'),sha256=crypto.createHash('sha256').update(await fs.readFile(zip)).digest('hex');
async function installCase(name,fail){
 const root=path.join(temp,'中文 路径',name),work=path.join(root,'data/updater');await fs.outputFile(path.join(root,'Pigeon.exe'),'old exe');await fs.outputFile(path.join(root,'resources/app.asar'),'old app');await fs.outputFile(path.join(root,'data/private.txt'),'KEEP');await fs.ensureDir(work);
 if(fail) await fs.outputFile(path.join(root,'resources/nested'),'obstruction');
 const job=path.join(work,'job.json');await fs.writeJson(job,{root,zip,version:'1.0.0',sha256,pid:0,testMode:true});
 let failed=false;try{ps('apply-update.ps1',['-JobFile',job]);}catch(e){failed=true;}
 assert.equal(failed,fail);
 assert.equal(await fs.readFile(path.join(root,'Pigeon.exe'),'utf8'),fail?'old exe':'new exe');
 assert.equal(await fs.readFile(path.join(root,'resources/app.asar'),'utf8'),fail?'old app':'new app');
 assert.equal(await fs.readFile(path.join(root,'data/private.txt'),'utf8'),'KEEP');
 assert.equal(await fs.pathExists(path.join(root,'dxcompiler.dll')),!fail);
 if(!fail) { assert.equal(await fs.readFile(path.join(root,'dxil.dll'),'utf8'),'runtime44');assert.equal(await fs.readFile(path.join(root,'version'),'utf8'),'44.9.0'); }
 assert.equal((await fs.readJson(path.join(work,'journal.json'))).status,fail?'restored':'installed');
}
await test('real Windows updater installs clean payload and preserves user data',()=>installCase('success',false));
await test('real Windows updater rolls back earlier files after a later copy fails',()=>installCase('rollback',true));
console.log('FEATURE_TEST_SUMMARY PASS '+passed+'; fixtures: '+temp);
})().catch(e=>{console.error(e);process.exitCode=1;});
