import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {build} from '../apps/desktop/node_modules/vite/dist/node/index.js';
const candidate=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),task=path.dirname(candidate),base=path.resolve(task,'../finance-experience-20261003/AI-Fenshen-finance-b44-renewed.app/public'),out=path.join(task,'web-candidate'),buildDir=path.join(task,'chat-build');
const req=createRequire(fs.realpathSync(path.join(candidate,'apps/desktop/node_modules/@vitejs/plugin-react/dist/index.mjs'))),babel=req('@babel/core');
const rel='assets/AIFenshenRealApp-CEcskaaC.js',host='/assets/index-C0nNzzuw.js',protectedHost='/'+rel;
const original=fs.readFileSync(path.join(base,rel),'utf8'),ast=babel.parseSync(original,{sourceType:'module',configFile:false,babelrc:false});
const functions=new Map(ast.program.body.filter(n=>n.type==='FunctionDeclaration').map(n=>[n.id.name,n]));
const protectedViews={'/FinanceView.jsx':'DM','/learning/LearningView.jsx':'OO','/DiaryView.jsx':'QO','/HealthView.jsx':'vO','/components/MeetingCenter.jsx':'tk'};
for(const symbol of Object.values(protectedViews))if(!functions.has(symbol))throw Error('Protected function missing: '+symbol);
const root=functions.get('Uk');if(!root||!original.slice(root.start,root.end).includes('financeF201Enabled'))throw Error('Root baseline mismatch');
const styles=new Set(['voiceChat.css','localMemory.css','mainChatActions.css']);
await build({configFile:false,root:candidate,base:'/assets/',logLevel:'warn',plugins:[{name:'protected-build44-host',enforce:'pre',resolveId(id){
 if(['react','react/jsx-runtime','react-dom'].includes(id))return '\0'+id;
 const key=Object.keys(protectedViews).find(suffix=>id.endsWith(suffix));if(key)return '\0protected:'+protectedViews[key];
 if(id.endsWith('/games/GamesView.jsx'))return '/assets/GamesView-44JwXGdh.js';
 if(id.endsWith('.css')&&!styles.has(path.basename(id)))return '\0protected-style:'+id;
},load(id){
 if(id==='\0react')return `import {r as React} from '${host}';export default React;export const {Children,Component,Fragment,Profiler,PureComponent,StrictMode,Suspense,cloneElement,createContext,createElement,createRef,forwardRef,isValidElement,lazy,memo,startTransition,use,useActionState,useCallback,useContext,useDebugValue,useDeferredValue,useEffect,useId,useImperativeHandle,useInsertionEffect,useLayoutEffect,useMemo,useOptimistic,useReducer,useRef,useState,useSyncExternalStore,useTransition,version}=React;`;
 if(id==='\0react/jsx-runtime')return `import {j as runtime} from '${host}';export const {jsx,jsxs,Fragment}=runtime;`;
 if(id==='\0react-dom')return `import {a as getDOM} from '${host}';const DOM=getDOM();export default DOM;export const {createPortal,flushSync,preconnect,prefetchDNS,preinit,preload,unstable_batchedUpdates}=DOM;`;
 if(id.startsWith('\0protected:'))return `export {${id.split(':')[1]} as default} from '${protectedHost}';`;
 if(id.startsWith('\0protected-style:'))return '';
}}],define:{'process.env.NODE_ENV':JSON.stringify('production'),'import.meta.env.VITE_AI_FENSHEN_GAMES_ENABLED':'"true"','import.meta.env.VITE_AI_FENSHEN_LEARNING_ENABLED':'"true"','import.meta.env.VITE_AI_FENSHEN_DIARY_ENABLED':'"true"','import.meta.env.VITE_AI_FENSHEN_HEALTH_ENABLED':'"true"'},esbuild:{jsx:'automatic'},worker:{format:'es'},build:{outDir:buildDir,emptyOutDir:true,lib:{entry:path.join(candidate,'apps/desktop/src/prototypes/aiFenshen/AIFenshenRealApp.jsx'),formats:['es'],fileName:()=> 'main-chat-20261003.js',cssFileName:'main-chat-20261003'},rollupOptions:{external:[host,protectedHost,'/assets/GamesView-44JwXGdh.js']},minify:true}});
fs.mkdirSync(out,{recursive:true});fs.cpSync(base,out,{recursive:true});
const replacement=`function ${root.id.name}(props){return a.jsx(MainChat20261003,props)}`;
const next=`import MainChat20261003 from './main-chat-20261003.js';\n`+original.slice(0,root.start)+replacement+original.slice(root.end)+`\nexport {${Object.values(protectedViews).join(',')}};\n`;
fs.writeFileSync(path.join(out,rel),next);
for(const file of fs.readdirSync(buildDir,{recursive:true}).filter(p=>fs.statSync(path.join(buildDir,p)).isFile())){const dest=path.join(out,'assets',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(buildDir,file),dest);}
fs.writeFileSync(path.join(out,'index.html'),fs.readFileSync(path.join(base,'index.html'),'utf8').replace('</head>','<link rel="stylesheet" href="/assets/GamesView-jJFuYZYL.css" />\n<link rel="stylesheet" href="/assets/main-chat-20261003.css" />\n</head>'));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex'),files=fs.readdirSync(base,{recursive:true}).filter(p=>fs.statSync(path.join(base,p)).isFile()),changed=files.filter(p=>sha(path.join(base,p))!==sha(path.join(out,p)));
if(JSON.stringify(changed.sort())!==JSON.stringify([rel,'index.html'].sort()))throw Error('Unexpected protected changes: '+changed);
const nextAst=babel.parseSync(next,{sourceType:'module',configFile:false,babelrc:false}),nextFunctions=new Map(nextAst.program.body.filter(n=>n.type==='FunctionDeclaration').map(n=>[n.id.name,n]));
for(const [name,node] of functions){if(name===root.id.name)continue;const after=nextFunctions.get(name);if(!after||original.slice(node.start,node.end)!==next.slice(after.start,after.end))throw Error('Protected function changed: '+name);}
fs.writeFileSync(path.join(task,'evidence/web-protection.json'),JSON.stringify({base:'1.0(44) accepted renewed',entry:rel,changed,protectedFilesUnchanged:files.length-changed.length,protectedFunctionsUnchanged:functions.size-1,originalViewExports:protectedViews,sourceBaseline:'Sept28 core; finance and learning compiled overlays retained',installed:false,deployed:false},null,2));
console.log('MAIN_CHAT_WEB_PROTECTION_PASS',files.length-changed.length,'files,',functions.size-1,'functions unchanged');
