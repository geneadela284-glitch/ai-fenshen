// Build an auditable learning-only delta against the protected dirty source plus
// the verified live account-protection overlay. This is not a release/checkpoint.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const root=process.cwd(),out='/private/tmp/ai-learning-evidence-20260910';
if(root!=='/private/tmp/ai-learning-v1-20260910')throw Error('WRONG_WORKSPACE');
const baseline=JSON.parse(fs.readFileSync(out+'/baseline-source-manifest.json'));
const overlay=JSON.parse(fs.readFileSync(out+'/live-code-delta.json'));
const references=new Map(baseline.files.map(f=>[f.path,{hash:f.sha256,file:path.join(baseline.source,f.path),kind:'protected-dirty-source'}]));
for(const f of overlay)references.set(f.path,{hash:f.sha256,file:path.join(out,'live-readonly-source',f.path),kind:'live-account-protection'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))].sort();
const label=process.argv[2]||'learning-development-after-218';
if(!/^[a-z0-9-]+$/.test(label))throw Error('INVALID_SNAPSHOT_LABEL');
const changes=[],patches=[];const bundle=path.join(out,label);
// Historical evidence must never be overwritten by a later development round.
fs.mkdirSync(bundle,{recursive:false});
for(const relative of files){
  if(relative==='AI_WORK_SECRETARY_PROJECT_STATE.md')continue; // Canonical is governed separately, never a source patch.
  const absolute=path.join(root,relative);
  if(!fs.existsSync(absolute)||!fs.statSync(absolute).isFile())continue;
  const bytes=fs.readFileSync(absolute),after=hash(bytes),reference=references.get(relative);
  if(reference?.hash===after)continue;
  if(reference&&hash(fs.readFileSync(reference.file))!==reference.hash)throw Error('REFERENCE_CHANGED:'+relative);
  const target=path.join(bundle,'source',relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  changes.push({path:relative,before:reference?.hash||null,after,reference:reference?.kind||'new-learning-file',bytes:bytes.length});
  const diff=spawnSync('git',['diff','--no-index','--no-ext-diff','--',reference?.file||'/dev/null',absolute],{encoding:'utf8',maxBuffer:4*1024*1024});
  if(![0,1].includes(diff.status))throw Error('DIFF_FAILED:'+relative);
  patches.push(diff.stdout.replace(/^diff --git .*$/m,`diff --git a/${relative} b/${relative}`).replace(/^--- .*$/m,reference?`--- a/${relative}`:'--- /dev/null').replace(/^\+\+\+ .*$/m,`+++ b/${relative}`));
}
const result={status:'DEVELOPMENT_ONLY_NOT_RELEASE',baseHead:'2ef2cc1f3d58b2edf50ac5c3cbdb409efd3a80cd',baselineFiles:baseline.files.length,accountProtectionFiles:overlay.length,changes};
fs.writeFileSync(path.join(bundle,'manifest.json'),JSON.stringify(result,null,2));
fs.writeFileSync(path.join(bundle,'learning-only.patch'),patches.join('\n'));
fs.writeFileSync(path.join(bundle,'README.txt'),'Development delta only. Not deployed, accepted, or a standalone release. Canonical metadata is excluded and governed by separate verified checkpoint receipts; this snapshot does not itself update project state. Read source/docs/learning/VALIDATION.md. Apply only against the protected dirty source plus the verified account overlay; never against old Git HEAD alone. No database, audio, credentials, or local session cookies are included.\n');
console.log(JSON.stringify({status:result.status,changedFiles:changes.length,bundle}));
