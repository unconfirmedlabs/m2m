import { bcs } from '@mysten/sui/bcs';
import { CodexWorker, CODEX_MODEL, CODEX_REASONING } from './codex-worker.js';
import { StreamingEngine } from './streaming-engine.js';
import { hash, utf8, equal, u64, exactKeys, creditHash, validateSigned, type SignedData, type CreditData } from './streaming-codec.js';
import { strictJson } from './native-peer.js';
import { readOptional, save } from './native-chain.js';

export const STREAMING_FEATURE='payment.sui.streaming.v1';
export const STREAMING_KIND=`extension.${STREAMING_FEATURE}`;
export interface ResearchRequest {version:1;conversation:string;request:string;sequence:string;prompt:string}
export type ResearchWorker=Pick<CodexWorker,'run'|'status'|'reconcile'|'cancel'>;
const bytes=()=>bcs.vector(bcs.u8());
const Request=bcs.struct('ResearchRequest',{purpose:bytes(),channel:bcs.Address,conversation:bytes(),request:bytes(),
  sequence:bcs.u64(),input:bytes(),model:bytes(),reasoning:bytes()});
export function requestHash(channel:string,request:ResearchRequest){
  exactKeys(request,['version','conversation','request','sequence','prompt']);u64(request.sequence);
  if(request.version!==1||request.sequence!=='1'||!(/^[0-9a-f]{64}$/.test(request.conversation))||!(/^[0-9a-f]{64}$/.test(request.request))||
    typeof request.prompt!=='string'||Buffer.byteLength(request.prompt)>16384)throw Error('invalid_research_request');
  return hash(Request.serialize({purpose:utf8('m2m/research/request/v1'),channel,conversation:Array.from(Buffer.from(request.conversation,'hex')),
    request:Array.from(Buffer.from(request.request,'hex')),sequence:request.sequence,input:utf8(request.prompt),model:utf8(CODEX_MODEL),reasoning:utf8(CODEX_REASONING)}).toBytes());
}
interface ServiceState {version:1;channel:string;request:ResearchRequest|null;started:boolean;cancelled:boolean}
export class ResearchService {
  private running?:Promise<unknown>;
  private constructor(readonly path:string,readonly engine:StreamingEngine,readonly worker:ResearchWorker,private state:ServiceState){}
  static async open(path:string,engine:StreamingEngine,worker:ResearchWorker){
    const channel=engine.snapshot().binding.channel;
    const state=await readOptional<ServiceState>(path)??{version:1,channel,request:null,started:false,cancelled:false};
    if(state.version!==1||state.channel!==channel||typeof state.started!=='boolean'||typeof state.cancelled!=='boolean')throw Error('research_state_mismatch');
    if(state.request)requestHash(channel,state.request);
    await save(path,state);return new ResearchService(path,engine,worker,state);
  }
  private ref(){const r=this.state.request;if(!r)throw Error('request_not_credited');return {agent:this.engine.snapshot().binding.offer.payload.buyer,
    conversationId:r.conversation,requestId:r.request};}
  private supervise(){
    if(!this.running&&this.state.request&&!this.state.cancelled)this.running=this.worker.run({...this.ref(),prompt:this.state.request.prompt})
      .catch(()=>{}).finally(()=>{this.running=undefined;});
  }
  /** Existing economic evidence remains recoverable after work stops or settles. */
  cached(bytes:number[]):number[]|undefined {
    const command=strictJson(bytes),records=this.engine.replay();
    if(command.op==='credit'){
      exactKeys(command,['op','request','credit']);
      const digest=requestHash(this.state.channel,command.request);
      const credit=validateSigned<CreditData>('credit',command.credit,this.engine.snapshot().binding.offer.payload.buyer_key);
      if(!equal(credit.payload.request_hash,digest))throw Error('request_credit_mismatch');
      const record=records.find(r=>equal(creditHash(r.credit.payload),creditHash(credit.payload)));
      if(record?.ack)return utf8(JSON.stringify({type:'ack',ack:record.ack}));
    }else if(command.op==='poll'){
      exactKeys(command,['op','request_hash','after_output']);u64(command.after_output);
      if(!this.state.request||!equal(command.request_hash,requestHash(this.state.channel,this.state.request)))throw Error('unknown_request');
      const cursor=BigInt(command.after_output);
      const delivery=records.flatMap(r=>r.deliveries).find(d=>BigInt(d.checkpoint.payload.units[1])>cursor||(d.checkpoint.payload.final&&BigInt(d.checkpoint.payload.units[1])===cursor));
      if(delivery)return utf8(JSON.stringify({type:'delivery',checkpoint:delivery.checkpoint,output:Array.from(Buffer.from(delivery.output_base64,'base64'))}));
    }
    return undefined;
  }
  async command(bytes:number[]):Promise<number[]>{
    const command=strictJson(bytes);let result:unknown;
    if(command.op==='credit'){
      exactKeys(command,['op','request','credit']);const request=command.request as ResearchRequest;
      const digest=requestHash(this.state.channel,request),credit=command.credit as SignedData<CreditData>;
      if(!equal(credit.payload.request_hash,digest)||credit.payload.request_sequence!==request.sequence)throw Error('request_credit_mismatch');
      if(this.state.request&&!equal(requestHash(this.state.channel,this.state.request),digest))throw Error('request_conflict');
      const policy=this.engine.snapshot().binding.policy;
      if(!equal(policy.units,[utf8('input_utf8_bytes'),utf8('output_utf8_bytes')]))throw Error('unsupported_research_policy');
      if(credit.payload.units[0]!==String(Buffer.byteLength(request.prompt)))throw Error('input_credit_mismatch');
      const ack=await this.engine.acceptCredit(credit);
      this.state.request=request;await save(this.path,this.state);result={type:'ack',ack};
    }else{
      if(!this.state.request||!equal(command.request_hash,requestHash(this.state.channel,this.state.request)))throw Error('unknown_request');
      if(command.op==='start'){
        exactKeys(command,['op','request_hash']);
        if(this.state.cancelled)throw Error('cancelled_before_start');
        if(!this.state.started){
          this.state.started=true;await save(this.path,this.state);
          // Worker journals turn launch and owns ambiguous launch reconciliation.
        }
        this.supervise();
        result={type:'started'};
      }else if(command.op==='cancel'){
        exactKeys(command,['op','request_hash']);this.state.cancelled=true;await save(this.path,this.state);
        const record=this.state.started?await this.worker.cancel(this.ref(),'buyer_cancelled'):undefined;
        result={type:'cancellation_requested',confirmed:!this.state.started||record?.state==='cancelled'};
      }else if(command.op==='poll'){
        exactKeys(command,['op','request_hash','after_output']);u64(command.after_output);
        if(!this.state.started){
          if(!this.state.cancelled)throw Error('request_not_started');
          if(command.after_output!=='0')throw Error('output_cursor_mismatch');
          const existing=this.engine.replay().flatMap(r=>r.deliveries).at(-1)?.checkpoint;
          const checkpoint=existing??await this.engine.deliver(['0','0'],new Uint8Array(),{final:true});
          return utf8(JSON.stringify({type:'delivery',checkpoint,output:[],worker_state:'cancelled'}));
        }
        if(this.state.cancelled)await this.worker.cancel(this.ref(),'buyer_cancelled');
        this.supervise();
        const records=this.engine.replay(),deliveries=records.flatMap(r=>r.deliveries),cursor=BigInt(command.after_output);
        const previous=deliveries.at(-1)?.checkpoint.payload.units??['0','0'];
        const replay=deliveries.find(d=>BigInt(d.checkpoint.payload.units[1])>cursor||(d.checkpoint.payload.final&&BigInt(d.checkpoint.payload.units[1])===cursor));
        if(replay)result={type:'delivery',checkpoint:replay.checkpoint,output:Array.from(Buffer.from(replay.output_base64,'base64'))};
        else{
          if(cursor!==BigInt(previous[1]))throw Error('output_cursor_mismatch');
          let work=this.worker.status(this.ref());
          if(!work)throw Error('uncertain_dispatch');
          if(!this.running&&!['completed','failed','cancelled'].includes(work.state))work=await this.worker.reconcile(this.ref());
          if(!work)throw Error('uncertain_dispatch');
          const generated=Buffer.concat(work.events.filter(e=>e.type==='content').map(e=>Buffer.from(e.type==='content'?e.delta:'')));
          const active=records.at(-1);if(!active?.ack)throw Error('missing_credit_ack');
          const ceiling=BigInt(active.credit.payload.units[1]);
          const remaining=ceiling-cursor;
          const count=Math.min(64,generated.length-Number(cursor),Number(remaining));
          const terminal=['completed','failed','cancelled'].includes(work.state);
          const final=terminal&&Number(cursor)+Math.max(0,count)===generated.length;
          if(count>0||final){
            const output=generated.subarray(Number(cursor),Number(cursor)+Math.max(0,count));
            const input=work.turnId||work.producedUtf8Bytes>0?String(Buffer.byteLength(this.state.request.prompt)):previous[0];
            const units=[input,String(Number(cursor)+output.length)];
            const checkpoint=await this.engine.deliver(units,output,{final});
            result={type:'delivery',checkpoint,output:Array.from(output),upstream_usage:work.upstreamUsage,worker_state:work.state};
          }else result={type:'waiting',reason:remaining===0n?'credit_exhausted':work.state,upstream_usage:work.upstreamUsage};
        }
      }else throw Error('unsupported_research_operation');
    }
    return utf8(JSON.stringify(result));
  }
  async finish(){await this.running;}
}
