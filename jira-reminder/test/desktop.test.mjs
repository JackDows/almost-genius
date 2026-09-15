import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeView, nextReminder, issueView } from '../web/view-state.mjs';
const status = { serverTime:'2026-09-15T05:00:00Z', connection:'connected', jira:{configured:true,issues:[],lastCheckAt:null}, work:{enabled:true,notice:'',today:{completed:false,sent:{},jira:null}} };

test('桌面运行标记区分后台失联、暂停、企业微信异常和正常运行', () => {
  assert.equal(runtimeView(status).text,'正在运行');
  assert.equal(runtimeView(status,false).text,'后台未连接');
  assert.equal(runtimeView({...status,work:{...status.work,enabled:false}}).text,'提醒已暂停');
  assert.equal(runtimeView({...status,connection:'disconnected'}).color,'amber');
});

test('下一次提醒按北京时间与今日完成状态变化', () => {
  assert.equal(nextReminder(status).time,'15:00');
  const evening = {...status,serverTime:'2026-09-15T12:00:00Z',work:{...status.work,today:{...status.work.today,jira:{issues:[]}}}};
  assert.equal(nextReminder(evening).time,'22:00');
  assert.equal(nextReminder({...evening,work:{...evening.work,today:{...evening.work.today,completed:true}}}).description,'明天 · 日报与临期检查');
  assert.equal(nextReminder({...evening,work:{...evening.work,enabled:false}}).time,'已暂停');
});

test('后台重启后仍显示今日保存的 Jira 检查，新查询结果优先', () => {
  const saved = {...status,work:{...status.work,today:{...status.work.today,jira:{checkedAt:'2026-09-15T07:00:00Z',issues:[{key:'T-1'}]}}}};
  assert.equal(issueView(saved).issues[0].key,'T-1');
  assert.deepEqual(issueView({...saved,jira:{lastCheckAt:'2026-09-15T08:00:00Z',issues:[]}}).issues,[]);
});
