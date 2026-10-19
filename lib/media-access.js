'use strict';
const path=require('path'),fs=require('fs-extra');
function badPath(){return Object.assign(new Error('Invalid media path'),{status:403});}
function inside(base,file){const rel=path.relative(base,file);return !!rel&&!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);}
async function resolveItemFile(root,pathname){
 let parts;try{parts=pathname.split('/').filter(Boolean).map(decodeURIComponent)}catch{throw badPath()}
 if(parts.length!==2||! /^[a-z0-9_-]{1,128}$/i.test(parts[0])||!parts[1]||parts[1]==='.'||parts[1]==='..'||/[\\/:\x00-\x1f]/.test(parts[1]))throw badPath();
 const realRoot=await fs.realpath(root),dir=await fs.realpath(path.join(realRoot,'images',parts[0]+'.info'));
 if(!inside(realRoot,dir))throw badPath();
 const file=await fs.realpath(path.join(dir,parts[1]));
 if(!inside(dir,file))throw badPath();
 return file;
}
function parseRange(range,size){
 if(!range)return null;
 const bad=()=>{throw Object.assign(new Error('Range not satisfiable'),{status:416})};
 const m=/^bytes=(\d*)-(\d*)$/.exec(range);
 if(!m||(!m[1]&&!m[2])||!Number.isSafeInteger(size)||size<=0)return bad();
 let start,end;
 if(!m[1]){const count=Number(m[2]);if(!Number.isSafeInteger(count)||count<=0)return bad();start=Math.max(0,size-count);end=size-1;}
 else {start=Number(m[1]);end=m[2]?Number(m[2]):size-1;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||end<start)return bad();end=Math.min(end,size-1);}
 return {start,end};
}
module.exports={resolveItemFile,parseRange};
