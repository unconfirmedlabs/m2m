import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
const {values}=parseArgs({options:{state:{type:'string',default:'.m2m/native-localnet'},wallet:{type:'string'}}});
if(!values.wallet)throw Error('Pass the localnet controller --wallet path');
const execute=promisify(execFile),reports=[];
for(const fault of ['after-delivery','after-close']){
  const session=`recovery-${fault}-${randomBytes(4).toString('hex')}`;
  const args=['--import','tsx','scripts/native-demo.ts','--state',values.state!,'--wallet',values.wallet,'--session',session,'--fixture'];
  await assert.rejects(()=>execute(process.execPath,[...args,'--fault',fault],{timeout:120000,maxBuffer:1024*1024}),/injected_after/);
  const before=JSON.parse(await readFile(join(values.state!,'runs',session,'buyer/binding.json'),'utf8'));
  const {stdout}=await execute(process.execPath,args,{timeout:120000,maxBuffer:1024*1024});
  const result=JSON.parse(stdout.trim());assert.equal(result.channel,before.channel);assert.equal(result.output_bytes,448);
  assert.equal(result.delivered_amount,result.redeemed_amount);assert.equal(BigInt(result.redeemed_amount)+BigInt(result.residual_refund),100000n);
  reports.push({fault,...result});
}
console.log(JSON.stringify({checks:'same-channel restart after persisted output and after uncertain close',reports}));
