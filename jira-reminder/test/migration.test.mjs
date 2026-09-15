import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { encryptBackup, decryptBackup, BackupService, dataDirectory } from '../src/backup.mjs';
import { CredentialStore, StateStore } from '../src/store.mjs';
import { WorkService } from '../src/work.mjs';
import { createSetupServer } from '../src/server.mjs';

const password = 'synthetic-pass-2026';
const sample = () => ({ format:1, state:{version:1, enabled:true, messages:{old:'done'}, days:{'2026-09-15':{completed:true, notes:[{kind:'daily',text:'测试设备联调'}], summary:'测试记录', sent:{'report15.wecom':'sent'}, jobs:{daily:{status:'pending'}}, outbox:{daily:{sent:false,text:'旧消息'}}}}}, wecom:{botId:'test-bot',secret:'synthetic-secret',userId:'test-user'}, jira:{username:'test-user',password:'synthetic-jira-password'} });
async function temporary(t) { const dir = await mkdtemp(path.join(os.tmpdir(),'jwr-migration-')); t.after(() => rm(dir,{recursive:true,force:true})); return dir; }

test('跨电脑备份使用独立密码，随机密文且不含账号原文；错误密码与篡改均拒绝', async () => {
  const value = sample(); const a = await encryptBackup(value,password), b = await encryptBackup(value,password);
  assert.notEqual(a,b); assert.ok(!a.includes('synthetic')); assert.deepEqual(await decryptBackup(a,password),value);
  await assert.rejects(decryptBackup(a,'wrong-password-123'));
  const changed = JSON.parse(a); changed.data = (changed.data[0] === 'A' ? 'B' : 'A') + changed.data.slice(1);
  await assert.rejects(decryptBackup(JSON.stringify(changed),password));
  const unsupported = JSON.parse(a); unsupported.version = 999;
  await assert.rejects(decryptBackup(JSON.stringify(unsupported),password));
});

test('全新用户没有备份也可初始化记录；无凭据备份仍可恢复', async t => {
  const dir = await temporary(t); assert.equal(await dataDirectory(dir),dir);
  const store = new StateStore(dir); await store.initialize();
  const backup = new BackupService(dir,store,{read:async()=>null},{read:async()=>null});
  const file = await backup.export(password);
  const restored = await decryptBackup(file,password);
  assert.equal(restored.wecom,null); assert.equal(restored.jira,null); assert.deepEqual(restored.state.days,{});
});

test('导入先验证再切换目录，重启后保留完成状态、重新加密凭据并暂停提醒', {skip:process.platform !== 'win32'}, async t => {
  const dir = await temporary(t), store = new StateStore(dir); await store.initialize();
  await store.update(s=>{s.days['2026-09-14']={completed:false,notes:[]};});
  const old = await readFile(store.filename,'utf8');
  const backup = new BackupService(dir,store,null,null), file = await encryptBackup(sample(),password);
  await assert.rejects(backup.import(file,password,false));
  await assert.rejects(backup.import(file,'wrong-password-123',true));
  assert.equal(await readFile(store.filename,'utf8'),old);
  await backup.import(file,password,true);
  assert.equal(await readFile(store.filename,'utf8'),old);
  const next = await dataDirectory(dir); assert.notEqual(next,dir);
  const restored = new StateStore(next); await restored.initialize();
  assert.equal(restored.snapshot().enabled,false);
  assert.equal(restored.snapshot().days['2026-09-15'].completed,true);
  assert.equal(restored.snapshot().days['2026-09-15'].outbox,undefined);
  assert.equal(restored.snapshot().days['2026-09-15'].jobs,undefined);
  assert.deepEqual(await new CredentialStore(next).read(),sample().wecom);
  assert.deepEqual(await new CredentialStore(next,'jira.dpapi').read(),sample().jira);
  assert.equal(await dataDirectory(dir),next);
  assert.equal(await readFile(store.filename,'utf8'),old);
});

test('周报连续修订带上上次回答，切换聊天不写入日报草稿，跨日回到日报', async t => {
  const store = new StateStore(await temporary(t)); await store.initialize();
  let instant = new Date('2026-09-15T15:00:00+08:00'); const calls=[];
  const writer = {notice:'', async summarize(kind,data) {calls.push({kind,data}); return kind === 'chat' ? '测试回答' : '测试草稿'+calls.length;}};
  const work = new WorkService({store,writer,wecom:{status:()=>({connection:'disconnected'})},scheduler:{},now:()=>instant});
  const wait = async()=>{while(work.processing) await new Promise(resolve=>setTimeout(resolve,5));};
  await work.handle('周报','1'); await work.handle('本周完成联调，下周现场测试','2'); await wait();
  await work.handle('删除现场测试，改为整理文档','3'); await wait();
  assert.equal(calls[1].kind,'weekly'); assert.equal(calls[1].data.currentDraft,'测试草稿1');
  assert.equal(calls[1].data.conversation[1].role,'assistant');
  assert.equal(calls[1].data.conversation.at(-1).text,'删除现场测试，改为整理文档');
  assert.equal(work.status().today.completed,false);
  await work.handle('聊天','4'); await work.handle('解释串口超时','5'); await wait();
  assert.equal(calls.at(-1).kind,'chat'); assert.equal(work.status().today.summary,'');
  const reload = new StateStore(store.directory); await reload.initialize();
  assert.equal(reload.snapshot().days['2026-09-15'].conversations.weekly.length,4);
  instant = new Date('2026-09-16T09:00:00+08:00'); assert.equal(work.status().mode,'daily');
});

test('备份接口必须有本机会话令牌，状态响应不包含密码', async t => {
  let exports=0;
  const {server}=createSetupServer({status:()=>({})},'<meta name="setup-token" content="__TOKEN__">',{backup:{export:async()=>{exports++;return 'ciphertext';}},auth:{status:()=>({state:'logged_out'})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/backup/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})})).status,403);
  assert.equal(exports,0);
  const token=(await(await fetch(base)).text()).match(/content="([a-f0-9]+)"/)[1];
  const response=await fetch(base+'/api/backup/export',{method:'POST',headers:{'Content-Type':'application/json','x-setup-token':token},body:JSON.stringify({password})});
  assert.deepEqual(await response.json(),{file:'ciphertext'}); assert.equal(exports,1);
  assert.ok(!(await(await fetch(base+'/api/status',{headers:{'x-setup-token':token}})).text()).includes(password));
});
