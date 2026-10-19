'use strict';
const assert=require('node:assert/strict'),fs=require('fs-extra'),path=require('node:path');
const {createUpdater,downloadArchive,REPO}=require('../lib/updater');
(async()=>{
 if(!process.env.PIGEON_TEST_TMP) throw Error('Set isolated PIGEON_TEST_TMP');
 const dir=await fs.mkdtemp(path.join(process.env.PIGEON_TEST_TMP,'github-live-'));
 const updater=createUpdater({app:{getVersion:()=>require('../package.json').version,isPackaged:false},baseDir:dir,canInstall:()=>false});
 const state=await updater.check();assert.notEqual(state.status,'error');console.log('LIVE_CHECK',state.status);
 const response=await fetch('https://api.github.com/repos/'+REPO+'/releases/latest',{headers:{'User-Agent':'Pigeon-Updater'}});
 assert.equal(response.status,200);const release=await response.json();
 const asset=release.assets.find(a=>a.name.endsWith('-lite.zip')) || release.assets.find(a=>a.name.endsWith('-win-x64.zip'));
 assert.ok(asset);assert.match(asset.digest,/^sha256:[a-f0-9]{64}$/i);
 const url=new URL(asset.browser_download_url);assert.equal(url.origin,'https://github.com');assert.ok(url.pathname.startsWith('/'+REPO+'/releases/download/'));
 const partial=path.join(dir,'public-asset.zip.part'),target=path.join(dir,'public-asset.zip');
 console.log('DOWNLOAD_START',release.tag_name,asset.name,asset.size);
 await downloadArchive({url:url.href,size:asset.size,sha256:asset.digest.slice(7)},partial,target);
 console.log('LIVE_DOWNLOAD_SHA256_PASS',target);
 console.log('Historical artifact used only to verify real GitHub transport and digest; never installed. This does not certify a new-release upgrade.');
})().catch(e=>{console.error(e);process.exitCode=1});
