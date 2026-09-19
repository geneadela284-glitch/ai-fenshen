import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const fail = code => Object.assign(new Error(code), { code });
const same = (a,b) => ['ownerId','conversationId','turnId'].every(k => a[k] && a[k] === b[k]);
function snapshot(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value,'invocation')) {
    const { invocation, ...data } = value;
    return { ...structuredClone(data), invocation };
  }
  return structuredClone(value);
}
export class VoiceWriteGate {
  constructor({clock=Date.now,ttlMs=120000}={}) { this.clock=clock;this.ttlMs=ttlMs;this.context=new AsyncLocalStorage();this.pending=new Map(); }
  wrap(service, readMethods=[], domain='record') {
    if(!service)return null;
    const allowed=typeof readMethods==='function'?readMethods:(method)=>readMethods.includes(method);
    // Domain runtimes may be frozen. A separate facade can wrap their methods
    // without violating Proxy invariants or weakening the original service.
    return new Proxy(Object.create(null),{get:(_target,method)=>{
      const value=Reflect.get(service,method,service);if(typeof value!=='function')return value;
      return (...args)=>{if(allowed(method,args))return value.apply(service,args);return this.capture(domain,String(method),args,stored=>value.apply(service,stored));};
    }});
  }
  capture(domain,method,args,execute) {
    const scope=this.context.getStore();if(!scope)throw fail('VOICE_WRITE_UNSCOPED');
    if(scope.operation){scope.multiple=true;throw fail('VOICE_MULTIPLE_WRITES');}
    const details=args.map(snapshot);
    scope.operation={domain,method,details,execute:()=>execute(details)};
    throw fail('VOICE_CONFIRMATION_REQUIRED');
  }
  async inspect(identity,operation) {
    if(!identity.ownerId||!identity.conversationId||!identity.turnId)throw fail('VOICE_IDENTITY_REQUIRED');
    const scope={...identity};let result;
    await this.context.run(scope,async()=>{try{result=await operation();}catch(e){if(e.code!=='VOICE_CONFIRMATION_REQUIRED')throw e;}});
    if(scope.multiple)throw fail('VOICE_MULTIPLE_WRITES');if(!scope.operation)return{result,proposal:null};
    this.prune();if(this.pending.size>=100)throw fail('VOICE_BUSY');
    const proposal={id:randomUUID(),...identity,expiresAt:this.clock()+this.ttlMs,...scope.operation,status:'pending'};
    this.pending.set(proposal.id,proposal);return{result:null,proposal};
  }
  async confirm(id,identity) {
    const proposal=this.pending.get(id);
    if(!proposal||!same(proposal,identity)||proposal.expiresAt<=this.clock()||proposal.status==='invalid')throw fail('VOICE_CONFIRMATION_EXPIRED');
    if(proposal.promise)return proposal.promise;
    proposal.status='executing';
    proposal.promise=Promise.resolve().then(()=>proposal.execute()).then(result=>{proposal.status='completed';return{domain:proposal.domain,method:proposal.method,result};},error=>{proposal.status='failed';throw error;});
    return proposal.promise;
  }
  invalidate(identity) { for(const p of this.pending.values())if(same(p,identity)&&p.status==='pending'){p.status='invalid';p.execute=null;} }
  prune() { for(const [id,p] of this.pending)if(p.expiresAt<=this.clock()&&p.status!=='executing')this.pending.delete(id); }
  close() { for(const p of this.pending.values())if(p.status==='pending')p.execute=null;this.pending.clear(); }
}
