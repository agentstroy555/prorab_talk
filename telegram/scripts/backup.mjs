import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const path=process.env.DB_PATH||'./var/agent-stroy.sqlite';
mkdirSync('var/backups',{recursive:true,mode:0o700});
const target=resolve('var/backups/agent-stroy-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
const db=new DatabaseSync(path);db.prepare('VACUUM INTO ?').run(target);db.close();console.log(target);
