'use strict';
// A public source snapshot must never include local history, reports or user data.
const fs=require('fs-extra'),path=require('path');
(async()=>{
 const dest=process.argv[2];if(!dest)throw Error('Usage: node scripts/export-public.cjs <new-directory>');
 const root=path.resolve(__dirname,'..'),out=path.resolve(dest);
 if(await fs.pathExists(out))throw Error('Output already exists');
 await fs.ensureDir(out);
 for(const name of ['.gitignore','README.md','package.json','package-lock.json','main.js','preload.js','build','extension','lib','renderer','scripts'])await fs.copy(path.join(root,name),path.join(out,name));
 console.log('PUBLIC_SOURCE_READY',out);
})().catch(e=>{console.error(e);process.exitCode=1});
