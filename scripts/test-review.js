'use strict';
const assert=require('node:assert/strict'),fs=require('fs-extra'),path=require('path'),crypto=require('crypto');
const {resolveItemFile,parseRange}=require('../lib/media-access');
const {createUpdater}=require('../lib/updater');
(async()=>{
 if(!process.env.PIGEON_TEST_TMP)throw Error('PIGEON_TEST_TMP required');
 await fs.ensureDir(process.env.PIGEON_TEST_TMP);const root=await fs.mkdtemp(path.join(process.env.PIGEON_TEST_TMP,'review-'));
 let failed=0,total=0;async function test(name,fn){total++;try{await fn();console.log('PASS',name)}catch(e){failed++;console.log('FAIL',name,e.message)}}
 await fs.outputFile(path.join(root,'images/ABC.info/图 片.png'),'image');
 await test('ordinary Unicode media path stays usable',async()=>assert.equal(await resolveItemFile(root,'/ABC/'+encodeURIComponent('图 片.png')),await fs.realpath(path.join(root,'images/ABC.info/图 片.png'))));
 await test('encoded traversal is refused',()=>assert.rejects(()=>resolveItemFile(root,'/ABC/..%5c..%5cprivate.txt')));
 await test('encoded nested path is refused',()=>assert.rejects(()=>resolveItemFile(root,'/ABC/..%2f..%2fprivate.txt')));
 await test('suffix range reads last bytes',()=>assert.deepEqual(parseRange('bytes=-3',10),{start:7,end:9}));
 await test('unsatisfiable range is refused',()=>assert.throws(()=>parseRange('bytes=10-',10)));
 await test('backwards range is refused',()=>assert.throws(()=>parseRange('bytes=7-2',10)));
 await test('range end clamps to the file boundary',()=>assert.deepEqual(parseRange('bytes=7-99',10),{start:7,end:9}));
 await test('oversized suffix returns the entire file',()=>assert.deepEqual(parseRange('bytes=-99',10),{start:0,end:9}));
 await test('empty file rejects byte range',()=>assert.throws(()=>parseRange('bytes=0-',0)));
 const bytes=Buffer.from('package'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
 const release={tag_name:'v1.0.0',assets:[{name:'Pigeon-1.0.0-win-x64.zip',browser_download_url:'https://github.com/Semyon11275/pigeon_tool/releases/download/v1.0.0/Pigeon-1.0.0-win-x64.zip',size:bytes.length,digest:'sha256:'+sha}]};
 const baseDir=path.join(root,'update'),args={app:{getVersion:()=> '0.9.3',isPackaged:false},baseDir,canInstall:()=>false,fetchImpl:async url=>url.includes('api.github.com')?{ok:true,json:async()=>release}:{ok:true,body:(async function*(){yield bytes})()}};
 const u=createUpdater(args);await u.check();await u.download();
 await test('checking again preserves verified download',async()=>assert.equal((await u.check()).status,'ready'));
 await test('restart restores a verified cache',async()=>assert.equal((await createUpdater(args).restore()).status,'ready'));
 await fs.writeFile(path.join(baseDir,'updater/update.zip'),'corrupt');
 await test('restart does not label corrupted cache verified',async()=>{const state=await createUpdater(args).restore();assert.notEqual(state.status,'ready');assert.match(state.error,/校验|损坏/)});
 await test('recheck rejects same-size damaged cache',async()=>{const state=await u.check();assert.equal(state.status,'error');assert.match(state.error,/校验/)});
 console.log('REVIEW_TEST',total-failed+'/'+total);if(failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
