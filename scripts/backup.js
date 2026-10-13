'use strict';
const fs=require('node:fs'); const path=require('node:path'); const {spawn}=require('node:child_process');
const cfg=require('../server/config');
if(cfg.dbMode!=='pg') throw new Error('Backup requires the project Docker PostgreSQL service');
const out=path.join(cfg.root,'data','backups');fs.mkdirSync(out,{recursive:true});
const file=path.join(out,'crm-bi-'+new Date().toISOString().replace(/[:.]/g,'-')+'.dump');
const fd=fs.openSync(file,'wx',0o600);
const child=spawn('docker',['compose','exec','-T','db','pg_dump','-U',process.env.PGADMIN_USER||'crm_owner','-d',cfg.pg.database,'-Fc'],{cwd:cfg.root,stdio:['ignore',fd,'pipe'],windowsHide:true});
fs.closeSync(fd);
let error='';child.stderr.on('data',buf=>{error+=buf.toString();});
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
child.on('close',code=>{if(code){console.error(error||'Backup failed');process.exitCode=1;}else console.log('Backup saved: '+file);});

