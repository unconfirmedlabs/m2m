import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Linux reference-runner advisory lock: released by the OS, including after a crash.
 * The tiny holder exits when its parent's stdin pipe closes. Never unlink lock files.
 */
export class NativeLock {
  private constructor(private child:ChildProcessWithoutNullStreams){}
  static async acquire(path:string){
    await mkdir(dirname(path),{recursive:true,mode:0o700});const file=await open(path,'a',0o600);await file.close();
    const child=spawn('flock',['--exclusive','--nonblock','--no-fork',path,process.execPath,'-e',
      'process.stdout.write("locked\\n");process.stdin.resume();'],{stdio:['pipe','pipe','pipe']});
    child.stderr.resume();
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('lock_timeout'));},5000);
      child.once('error',()=>{clearTimeout(timer);reject(Error('lock_unavailable'));});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('state_directory_in_use'));});
      child.stdout.once('data',data=>{clearTimeout(timer);if(String(data)!=='locked\n')reject(Error('lock_failed'));else resolve();});});
    return new NativeLock(child);
  }
  async close(){
    if(this.child.exitCode!==null)return;
    await new Promise<void>(done=>{this.child.once('exit',()=>done());this.child.stdin.end();});
  }
}
