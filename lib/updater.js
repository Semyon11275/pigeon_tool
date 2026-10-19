'use strict';
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const REPO = 'Semyon11275/pigeon_tool';
function version(v) { const m=/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v || ''); if(!m) throw new Error('更新版本号必须为正式版本 x.y.z'); return m.slice(1).map(Number); }
function newer(a,b) { const x=version(a),y=version(b); for(let i=0;i<3;i++) if(x[i]!==y[i]) return x[i]>y[i]; return false; }
function chooseRelease(release, current) {
  if (!release || !/^v?\d+\.\d+\.\d+$/.test(release.tag_name || '')) return null;
  if (release.draft || release.prerelease || !newer(release.tag_name,current)) return null;
  const v=release.tag_name.replace(/^v/,'');
  const asset=(release.assets || []).find(a=>a.name==='Pigeon-'+v+'-win-x64.zip');
  if(!asset || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '')) throw new Error('该版本缺少经过 SHA-256 校验的 Windows 更新包');
  const u=new URL(asset.browser_download_url);
  if(u.origin!=='https://github.com' || !u.pathname.startsWith('/'+REPO+'/releases/download/')) throw new Error('更新包来源不受信任');
  if(!Number.isSafeInteger(asset.size) || asset.size<=0 || asset.size>2*1024**3) throw new Error('更新包大小不合法');
  return { version:v, url:u.href, sha256:asset.digest.slice(7).toLowerCase(), size:asset.size, notes:String(release.body || '').slice(0,20000) };
}
async function downloadArchive(info, partial, target, fetchImpl=fetch, onProgress=()=>{}) {
  const r=await fetchImpl(info.url,{signal:AbortSignal.timeout(15*60e3)});
  if(!r.ok || !r.body) throw new Error('下载失败：HTTP '+r.status);
  const fd=await fs.promises.open(partial,'w'); const hash=crypto.createHash('sha256'); let count=0;
  try { for await(const chunk of r.body) { count+=chunk.length; if(count>info.size) throw new Error('更新包超过声明大小'); hash.update(chunk); await fd.writeFile(chunk); onProgress(Math.round(count/info.size*100)); } }
  finally { await fd.close(); }
  if(count!==info.size || hash.digest('hex')!==info.sha256) throw new Error('更新包校验失败，未安装');
  await fs.move(partial,target,{overwrite:true});
}
function createUpdater({app, baseDir, canInstall, fetchImpl=fetch, spawnImpl=spawn}) {
  const dir=path.join(baseDir,'updater');
  let state={status:'idle',current:app.getVersion(),progress:0,error:'',available:null}, busy=false;
  const snapshot=()=>({...state,installSupported:app.isPackaged && process.platform==='win32' && process.arch==='x64'});
  async function restore() {
    const result=await fs.readJson(path.join(dir,'result.json')).catch(()=>null);
    if(result?.status==='failed') state={...state,status:'error',error:'上次更新失败：'+result.error};
    const info=await fs.readJson(path.join(dir,'download.json')).catch(()=>null);
    if(info && /^https:\/\/github\.com\//.test(info.url || '') && /^[a-f0-9]{64}$/.test(info.sha256 || '') && await fs.pathExists(path.join(dir,'update.zip'))) {
      try { if(newer(info.version,app.getVersion())) state={...state,status:'ready',available:info,progress:100}; } catch(_) {}
    }
    return snapshot();
  }
  async function check() {
    if(busy) return snapshot(); busy=true;
    state={...state,status:'checking',error:''};
    try {
      const r=await fetchImpl('https://api.github.com/repos/'+REPO+'/releases/latest',{headers:{Accept:'application/vnd.github+json','User-Agent':'Pigeon-Updater'},signal:AbortSignal.timeout(20000)});
      if(r.status===404) { state={...state,status:'unpublished',available:null}; return snapshot(); }
      if(!r.ok) throw new Error('检查更新失败：HTTP '+r.status);
      const release=await r.json();
      const available=chooseRelease(release,app.getVersion());
      const eligible=release && !release.draft && !release.prerelease && /^v?\d+\.\d+\.\d+$/.test(release.tag_name || '');
      state={...state,status:available?'available':eligible?'current':'unpublished',available,progress:0};
    } catch(e) { state={...state,status:'error',error:e.message}; }
    finally { busy=false; }
    return snapshot();
  }
  async function download() {
    if(busy) return snapshot();
    if(!state.available) throw new Error('请先检查更新');
    busy=true; const info={...state.available};
    const partial=path.join(dir,'update.zip.part'), target=path.join(dir,'update.zip');
    try {
      await fs.ensureDir(dir); state={...state,status:'downloading',progress:0,error:''};
      await downloadArchive(info,partial,target,fetchImpl,progress=>{state.progress=progress;});
      await fs.writeJson(path.join(dir,'download.json'),info);
      state={...state,status:'ready',progress:100};
    } catch(e) { await fs.remove(partial).catch(()=>{}); state={...state,status:'error',error:e.message}; }
    finally { busy=false; }
    return snapshot();
  }
  async function install() {
    if(busy || state.status!=='ready') throw new Error('请先下载并校验更新');
    if(!snapshot().installSupported) throw new Error('仅 Windows x64 便携发行版支持安装更新；开发环境只允许检查与下载');
    if(!canInstall()) throw new Error('仍有导入、转换或 AI 任务，请等待完成后再更新');
    busy=true;
    try {
      const zip=path.join(dir,'update.zip');
      const hash=crypto.createHash('sha256'); for await(const chunk of fs.createReadStream(zip)) hash.update(chunk);
      if(hash.digest('hex')!==state.available.sha256) throw new Error('更新包发生变化，请重新下载');
      const script=path.join(dir,'apply-update.ps1');
      await fs.copy(path.join(__dirname,'../scripts/apply-update.ps1'),script);
      const job={root:path.dirname(process.execPath),zip,version:state.available.version,pid:process.pid,exe:path.basename(process.execPath),sha256:state.available.sha256};
      const jobPath=path.join(dir,'job.json'); await fs.writeJson(jobPath,job);
      await new Promise((resolve,reject)=>{
        const child=spawnImpl('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-JobFile',jobPath],{detached:true,stdio:'ignore',windowsHide:true});
        child.once('error',reject); child.once('spawn',()=>{child.unref();resolve();});
      });
      state.status='installing'; app.quit(); return snapshot();
    } catch(e) { busy=false; state={...state,status:'error',error:e.message}; throw e; }
  }
  return {snapshot,restore,check,download,install};
}
module.exports={createUpdater,chooseRelease,newer,version,REPO,downloadArchive};
