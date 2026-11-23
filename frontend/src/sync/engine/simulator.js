/**
 * 同步模拟台编排：组装估算存储、发送方、收件排班表与模拟传输，
 * 派生逐单状态与同步完成判定，并保留事件流。
 */

import { EstimateStore } from './store.js';
import { ScheduleTable, APPLY } from './receiver.js';
import { Sender } from './sender.js';
import { Transport, resetRng } from './transport.js';

export const JOB_STATE = Object.freeze({
  UNPUBLISHED: 'unpublished',     // 估算未完成，未发布
  IN_FLIGHT: 'in-flight',         // 新版已打包，尚在途中
  NEEDS_RETRY: 'needs-retry',     // 包/回执丢失，等待补发
  APPLIED_UNACKED: 'applied-unacked', // 已入表生效，但回执未到
  SYNCED: 'synced',               // 已生效且已确认
});

export class SyncSimulator {
  constructor() {
    this.store = new EstimateStore();
    this.sender = new Sender(this.store);
    this.receiver = new ScheduleTable();
    this.events = [];
    this.transport = new Transport(this.sender, this.receiver, {
      onEvent: event => {
        this.events.push({ seq: this.events.length + 1, at: new Date().toISOString(), ...event });
        if (this.listener) this.listener(this.snapshot());
      },
    });
    this.listener = null;
    this.#seedOutbox();
  }

  /** 初始三条已完成估算作为 v1 增量进入 outbox（尚未发给排班表）。 */
  #seedOutbox() {
    for (const jobId of Object.keys(this.store.estimates).sort()) {
      if (this.store.active(jobId)) {
        const record = this.store.upsert(jobId, this.store.estimates[jobId].estimated_minutes);
        this.sender.enqueue(record);
      }
    }
  }

  subscribe(listener) { this.listener = listener; }

  // ---- 估算侧操作（每次都产出一条增量并进入 outbox） ----
  upsert(jobId, minutes) {
    const record = this.store.upsert(jobId, minutes);
    this.sender.enqueue(record);
    this.#notify();
    return record;
  }

  retract(jobId) {
    const record = this.store.retract(jobId);
    if (record) {
      this.sender.enqueue(record);
      this.#notify();
    }
    return record;
  }

  /** 完成尚未估算工单的首次估算（新增）。 */
  completeEstimate(jobId, minutes) {
    return this.upsert(jobId, minutes);
  }

  // ---- 发件 ----
  /** 发增量包：指定 recordIds 为选择性打包，省略则补发全部待确认单。 */
  send(recordIds = null, note = '') {
    const packet = this.sender.buildPacket(recordIds, note);
    if (packet) this.transport.dispatch(packet);
    this.#notify();
    return packet;
  }

  /** 断网恢复后的逐单补发：只重发仍未确认的记录（同 record_id、同版本）。 */
  retryUnconfirmed(note = '断网恢复·逐单补发') {
    if (!this.transport.online) return null;
    const packet = this.sender.buildPacket(null, note);
    if (packet) this.transport.dispatch(packet);
    this.#notify();
    return packet;
  }

  // ---- 网络与收包 ----
  configureNetwork(options) { this.transport.configure(options); this.#notify(); }
  reconnect() { this.transport.reconnect(); this.#notify(); }
  deliverNow(packetId) { this.transport.deliverNow(packetId); this.#notify(); }
  reconcile() { const ids = this.transport.reconcile(); this.#notify(); return ids; }

  // ---- 状态派生 ----
  jobView(jobId) {
    const estimate = this.store.estimates[jobId] ?? null;
    const latest = this.store.latest(jobId);
    const applied = this.receiver.appliedVersionOf(jobId);
    const confirmed = this.sender.confirmedVersions().get(jobId) ?? 0;
    const tableRow = this.receiver.get(jobId);

    let state;
    if (latest === 0) state = JOB_STATE.UNPUBLISHED;
    else if (applied >= latest) state = confirmed >= latest ? JOB_STATE.SYNCED : JOB_STATE.APPLIED_UNACKED;
    else {
      const recordId = `${jobId}#v${latest}`;
      const flying = this.transport.flight.some(n =>
        (n.state === 'flying' || n.state === 'delayed') &&
        n.packet.records.some(r => r.record_id === recordId));
      state = flying ? JOB_STATE.IN_FLIGHT : JOB_STATE.NEEDS_RETRY;
    }
    return {
      job_id: jobId, estimate, latest_version: latest,
      applied_version: applied, confirmed_version: confirmed,
      table_row: tableRow, state,
    };
  }

  jobViews() {
    return Object.keys(this.store.estimates).sort().map(id => this.jobView(id));
  }

  /** 待补清单：最新版本尚未在排班表生效的工单。 */
  pendingJobs() {
    return this.jobViews().filter(v => v.applied_version < v.latest_version);
  }

  /** 已生效清单：排班表已应用该单最新版本（无论回执是否到达）。 */
  effectiveJobs() {
    return this.jobViews().filter(v => v.latest_version > 0 && v.applied_version >= v.latest_version);
  }

  outboxRows() {
    return [...this.sender.outbox.values()].map(item => ({
      record_id: item.record.record_id,
      job_id: item.record.job_id,
      version: item.record.version,
      op: item.record.op,
      estimated_minutes: item.record.estimated_minutes,
      status: item.status,
      packets: [...item.sent_packet_ids],
      acked_at: item.acked_at,
    })).sort((a, b) => a.record_id.localeCompare(b.record_id));
  }

  flightRows() {
    return this.transport.flight.map(node => ({
      packet_id: node.packet.packet_id,
      state: node.state,
      records: node.packet.records.map(r => r.record_id),
      note: node.packet.note,
    }));
  }

  /** 同步完成判定：排班表与最新估算规范集合完全一致。 */
  syncStatus() {
    const target = this.store.targetEntries();
    const diff = this.receiver.diff(target);
    const pendingConfirm = this.sender.pending().length;
    return {
      ...diff,
      pending_confirm: pendingConfirm,
      target_count: target.length,
      table_count: this.receiver.rows().length,
      // 内容一致即同步完成；回执只影响在途确认，不影响表的正确性
      fully_acked: pendingConfirm === 0,
    };
  }

  snapshot() {
    return {
      jobs: this.jobViews(),
      outbox: this.outboxRows(),
      flight: this.flightRows(),
      table: this.receiver.rows(),
      sync: this.syncStatus(),
      online: this.transport.online,
      lossRate: this.transport.lossRate,
      reorder: this.transport.reorder,
      events: [...this.events],
    };
  }

  #notify() { if (this.listener) this.listener(this.snapshot()); }

  reset() {
    this.transport.reset();
    this.store.reset();
    this.sender.reset(this.store);
    this.receiver.reset();
    this.events.length = 0;
    resetRng();
    this.#seedOutbox();
    this.#notify();
  }
}

export { APPLY };
