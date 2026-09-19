import { documentError } from '../../../../core/documentQa/contract.js';
export class DocumentSession {
  constructor({ownerId,parser,onChange=()=>{}}={}){this.ownerId=ownerId;this.parser=parser;this.onChange=onChange;this.epoch=0;this.current=null;this.conversationId=null;this.controller=null;this.state='idle';this.closed=false;}
  publish(state,extra={}){this.state=state;this.onChange({state,document:this.current,...extra});}
  token(){return {epoch:this.epoch,documentId:this.current?.record.documentId,revision:this.current?.record.revision};}
  isCurrent(token){return !this.closed&&token?.epoch===this.epoch&&token.documentId===this.current?.record.documentId&&token.revision===this.current?.record.revision;}
  clear(){this.epoch++;this.controller?.abort();this.controller=null;this.current=null;this.publish('idle');}
  bindConversation(id){if(this.conversationId&&this.conversationId!==id)this.clear();this.conversationId=id;}
  adopt(document){if(document.record.ownerId!==this.ownerId)throw documentError('DOCUMENT_OWNER_MISMATCH');this.clear();this.current=document;this.publish('ready');}
  async select(file){this.clear();const epoch=this.epoch;const controller=new AbortController();this.controller=controller;this.publish('parsing',{filename:file.name});
    try{const document=await this.parser(file,{ownerId:this.ownerId,signal:controller.signal,onProgress:progress=>{if(epoch===this.epoch&&!this.closed)this.publish('parsing',{filename:file.name,progress});}});
      if(epoch!==this.epoch||this.closed)return;this.current=document;this.publish('ready');
    }catch(error){if(epoch!==this.epoch||this.closed||controller.signal.aborted)return;this.publish('failed',{errorCode:error?.code||'DOCUMENT_INVALID'});}
  }
  close(){this.clear();this.closed=true;}
}
