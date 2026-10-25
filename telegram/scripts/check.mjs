import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
function walk(p) { for (const e of readdirSync(p, { withFileTypes: true })) { const f=p+'/'+e.name; if(e.isDirectory())walk(f);else if(/\.(js|mjs)$/.test(f))execFileSync(process.execPath,['--check',f]); } }
walk('src');walk('scripts');walk('test');console.log('Syntax OK');
