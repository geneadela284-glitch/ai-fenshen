import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directories=['server/conversation','server/voiceChat','server/attachments','memory/entity','memory/mobile','server/finance','server/agent','server/learning','server/health','server/diary','server/meeting','core/meeting/phase0','core/meeting/stage3a','core/meeting/stage3b','core/meeting/stage3c','core/meeting/stage4','apps/desktop/src/components/meeting','apps/desktop/src/components/meeting/recording','apps/desktop/src/components/meeting/playback','apps/desktop/src/prototypes/aiFenshen/learning','apps/desktop/src/prototypes/aiFenshen/voiceChat'];
let files=directories.flatMap(dir=>fs.readdirSync(path.join(root,dir)).filter(f=>f.endsWith('.test.js')).map(f=>path.join(dir,f)));
const proto='apps/desktop/src/prototypes/aiFenshen';
files.push(...fs.readdirSync(path.join(root,proto)).filter(f=>/^(?:dictation|localMemoryClient|attachment|image|realConversation|realSettingsEntry|prototypeState|sessionBootstrap|accountSessionBoundary).*\.test\.js$/.test(f)).map(f=>path.join(proto,f)));
files=[...new Set(files)].sort();
const result=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit'});process.exit(result.status??1);
