import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EstimateStore, OP } from '../frontend/src/sync/engine/store.js';
import { ScheduleTable, APPLY } from '../frontend/src/sync/engine/receiver.js';
import { Sender } from '../frontend/src/sync/engine/sender.js';
import { Transport, FLIGHT } from '../frontend/src/sync/engine/transport.js';
import { SyncSimulator, JOB_STATE } from '../frontend/src/sync/engine/simulator.js';

function harness() {
  const sim = new SyncSimulator();
  return { sim, store: sim.store, sender: sim.sender, receiver: sim.receiver, transport: sim.transport };
}

const settle = (ms = 1200) => new Promise(resolve => setTimeout(resolve, ms));

test('增量发布：新增为 UPSERT，改值版本递增，撤回为 RETRACT，未估算工单不发布', () => {
  const store = new EstimateStore();
  assert.equal(store.latest('QJ-N04'), 0);
  const r0 = store.upsert('QJ-N01', 146); // 首次发布 -> v1
  assert.deepEqual([r0.op, r0.version], [OP.UPSERT, 1]);
  const r1 = store.upsert('QJ-N01', 150); // 改值版本递增 -> v2
  assert.deepEqual([r1.op, r1.version], [OP.UPSERT, 2]);
  const r3 = store.upsert('QJ-N04', 305); // 新增（之前未完成估算）
  assert.deepEqual([r3.op, r3.version], [OP.UPSERT, 1]);
  const r4 = store.retract('QJ-N02');
  assert.equal(r4.op, OP.RETRACT);
  assert.equal(r4.version, 1); // 预置前未发布过的存储，首次版本即撤回
  assert.equal(store.retract('QJ-N99'), null); // 未入表无需撤回
  // 撤回后目标集合不含该单
  assert.deepEqual(store.targetEntries().map(r => r.job_id), ['QJ-N01', 'QJ-N03', 'QJ-N04']);
});

test('乱序到达：高版本先生效，迟到的低版本不能覆盖新版', () => {
  const table = new ScheduleTable();
  const v1 = { record_id: 'J#v1', job_id: 'J', version: 1, op: OP.UPSERT, estimated_minutes: 100, title: 't' };
  const v2 = { record_id: 'J#v2', job_id: 'J', version: 2, op: OP.UPSERT, estimated_minutes: 120, title: 't' };
  assert.equal(table.apply(v2), APPLY.APPLIED);
  assert.equal(table.apply(v1), APPLY.STALE);
  assert.equal(table.get('J').estimated_minutes, 120);
  assert.equal(table.appliedVersionOf('J'), 2);
});

test('撤回后迟到的旧 UPSERT 不能让撤单复活', () => {
  const table = new ScheduleTable();
  const v1 = { record_id: 'J#v1', job_id: 'J', version: 1, op: OP.UPSERT, estimated_minutes: 100, title: 't' };
  const v2 = { record_id: 'J#v2', job_id: 'J', version: 2, op: OP.RETRACT, estimated_minutes: null, title: 't' };
  table.apply(v1);
  table.apply(v2);
  assert.equal(table.has('J'), false);
  assert.equal(table.apply(v1), APPLY.STALE);
  assert.equal(table.has('J'), false);
  // 新版重新估算可以回来
  const v3 = { record_id: 'J#v3', job_id: 'J', version: 3, op: OP.UPSERT, estimated_minutes: 130, title: 't' };
  table.apply(v3);
  assert.equal(table.get('J').estimated_minutes, 130);
});

test('同版本重复投递幂等：不重复入表，回执可重复处理', async () => {
  const { sim, sender, receiver, transport } = harness();
  transport.configure({ lossRate: 0, reorder: false });
  sim.upsert('QJ-N01', 150); // 预置 v1 之后的改值 -> v2
  const pkt1 = sim.send(null, '首包');
  await settle();
  // 预置三条 + 本次改值共四条记录；N01 改值覆盖原行，排班表为 3 行
  assert.equal(receiver.rows().length, 3);
  // 模拟回执丢失：把该单 outbox 项重置为待确认后重发同一版本
  const item = sender.outbox.get('QJ-N01#v2');
  item.status = 'pending';
  item.acked_at = null;
  const pkt2 = sim.retryUnconfirmed();
  assert.ok(pkt2 && pkt2.packet_id !== pkt1.packet_id);
  assert.deepEqual(pkt2.records.map(r => r.record_id), ['QJ-N01#v2']);
  await settle();
  assert.equal(receiver.rows().length, 3); // 补发未重复入表
  assert.equal(receiver.appliedVersionOf('QJ-N01'), 2);
  assert.equal(transport.flight.length, 2);
});

test('断网：发出未确认的单恢复后逐单补发，最终一致且不重复', async () => {
  const { sim, receiver, transport } = harness();
  transport.configure({ online: false });
  sim.upsert('QJ-N01', 150);
  const held = sim.send(null, '断网前发出');
  assert.equal(transport.flight[0].state, FLIGHT.FLYING);
  // 断网期间又来新批（改值 + 撤回），照样可以打包发出并挂起
  sim.upsert('QJ-N02', 230);
  sim.retract('QJ-N03');
  sim.send(null, '断网期间新批');
  // 恢复网络：挂起包开始投递；未确认单再补发
  transport.configure({ online: true });
  sim.reconnect();
  await settle(3200);
  const before = receiver.rows().length;
  const retry = sim.retryUnconfirmed();
  await settle();
  assert.equal(receiver.rows().length, before); // 补发不重复
  // 同步完成判定
  const status = sim.syncStatus();
  assert.equal(status.in_sync, true, JSON.stringify(status));
  assert.deepEqual(status.missing, []);
  assert.deepEqual(status.extra, []);
  void held; void retry;
});

test('回执丢失：记录已入表，按逐单实收对账确认，无需重新生成版本', async () => {
  const { sim, sender, receiver, transport } = harness();
  // 100% 丢回执不易定向，直接构造：包到达后把 outbox 项重置为 pending
  transport.configure({ lossRate: 0 });
  sim.upsert('QJ-N01', 150);
  sim.send();
  await settle();
  assert.equal(receiver.appliedVersionOf('QJ-N01'), 2);
  const item = sender.outbox.get('QJ-N01#v2');
  assert.equal(item.status, 'confirmed');
  item.status = 'pending'; // 模拟回执在网络中丢失
  item.acked_at = null;
  const confirmed = sim.reconcile();
  assert.deepEqual(confirmed, ['QJ-N01#v2']);
  assert.equal(item.status, 'confirmed');
  assert.equal(sim.syncStatus().in_sync, true);
});

test('分批收包与同步判定：部分生效时 in_sync=false，待补清单准确', async () => {
  const { sim } = harness();
  sim.transport.configure({ lossRate: 0 });
  sim.upsert('QJ-N01', 150);
  sim.upsert('QJ-N02', 230);
  const pkt = sim.send(['QJ-N01#v2'], '分批一');
  assert.ok(pkt);
  await settle();
  const pending = sim.pendingJobs().map(v => v.job_id);
  assert.deepEqual(pending, ['QJ-N02', 'QJ-N03']);
  assert.deepEqual(sim.effectiveJobs().map(v => v.job_id), ['QJ-N01']);
  assert.equal(sim.syncStatus().in_sync, false);
  // 收第二批
  sim.send(null, '分批二（补发剩余）');
  await settle();
  assert.equal(sim.syncStatus().in_sync, true);
  assert.equal(sim.syncStatus().fully_acked, true);
});

test('全流程状态机：未发布→在途→已生效待确认→已确认', async () => {
  const { sim } = harness();
  sim.transport.configure({ lossRate: 0 });
  assert.equal(sim.jobView('QJ-N04').state, JOB_STATE.UNPUBLISHED);
  sim.completeEstimate('QJ-N04', 305);
  sim.send();
  assert.equal(sim.jobView('QJ-N04').state, JOB_STATE.IN_FLIGHT);
  await settle();
  assert.equal(sim.jobView('QJ-N04').state, JOB_STATE.SYNCED);
  // 丢包后转待补
  sim.transport.configure({ lossRate: 1 });
  sim.upsert('QJ-N04', 320);
  sim.send();
  await settle();
  assert.equal(sim.jobView('QJ-N04').state, JOB_STATE.NEEDS_RETRY);
  sim.transport.configure({ lossRate: 0 });
  sim.retryUnconfirmed();
  await settle();
  assert.equal(sim.jobView('QJ-N04').state, JOB_STATE.SYNCED);
  assert.equal(sim.receiver.get('QJ-N04').estimated_minutes, 320);
});

test('reset 后回到初始演示态', () => {
  const { sim } = harness();
  sim.upsert('QJ-N01', 1);
  sim.reset();
  assert.equal(sim.store.latest('QJ-N01'), 1); // 重置后重新预置 v1 待发包
  assert.equal(sim.receiver.rows().length, 0);
  assert.deepEqual(sim.pendingJobs().map(v => v.job_id), ['QJ-N01', 'QJ-N02', 'QJ-N03']);
  assert.equal(sim.jobView('QJ-N04').state, JOB_STATE.UNPUBLISHED);
});
