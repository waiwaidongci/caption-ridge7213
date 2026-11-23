/**
 * 模拟传输层：不真的联网，只按策略决定数据包/回执的去向与顺序。
 *
 * 可模拟：
 *  - offline：断网，发送的包与恢复后的补发都先留在在途队列；
 *  - lossRate：随机丢包（数据包或回执各自独立判定）；
 *  - reorder：高延迟包后发先至，验证乱序旧记录不能覆盖新版；
 *  - 数据包到达后由收件方应用并产生逐单回执；回执同样可能丢失。
 *
 * 所有事件都进事件流，供页面回放「已生效 / 待补」的判定过程。
 */

export const FLIGHT = Object.freeze({ FLYING: 'flying', DELAYED: 'delayed', LOST: 'lost', DELIVERED: 'delivered' });

let rngSeed = 261123;
function rand() { // 确定性 LCG，刷新页面前的演示可复现
  rngSeed = (rngSeed * 1664525 + 1013904223) >>> 0;
  return rngSeed / 4294967296;
}
export function resetRng(seed = 261123) { rngSeed = seed; }

export class Transport {
  constructor(sender, receiver, { onEvent } = {}) {
    this.sender = sender;
    this.receiver = receiver;
    this.onEvent = onEvent ?? (() => {});
    this.online = true;
    this.lossRate = 0;
    this.reorder = false;
    /** 在途数据包 */
    this.flight = [];
    /** 在途回执 */
    this.ackFlight = [];
    this.timers = [];
  }

  configure({ online, lossRate, reorder }) {
    if (online !== undefined) this.online = online;
    if (lossRate !== undefined) this.lossRate = Math.min(1, Math.max(0, lossRate));
    if (reorder !== undefined) this.reorder = reorder;
  }

  /** 发送一个已打好的包：断网则挂起，否则按丢包/乱序策略投递。 */
  dispatch(packet) {
    const node = {
      kind: 'packet', packet, state: FLIGHT.FLYING,
      queued_at: Date.now(), arrives_at: Date.now() + 600,
    };
    this.flight.push(node);
    this.onEvent({ type: 'packet-sent', packet_id: packet.packet_id,
      records: packet.records.map(r => r.record_id), note: packet.note });
    if (!this.online) {
      node.state = FLIGHT.FLYING;
      this.onEvent({ type: 'offline-held', packet_id: packet.packet_id });
      return node;
    }
    this.#schedulePacket(node);
    return node;
  }

  #schedulePacket(node) {
    const roll = rand();
    if (roll < this.lossRate) {
      node.state = FLIGHT.LOST;
      this.onEvent({ type: 'packet-lost', packet_id: node.packet.packet_id, roll });
      return;
    }
    if (this.reorder) {
      node.state = FLIGHT.DELAYED;
      node.arrives_at = Date.now() + 2600 + rand() * 1200;
      this.onEvent({ type: 'packet-reordered', packet_id: node.packet.packet_id });
    }
    const delay = Math.max(0, node.arrives_at - Date.now());
    const timer = setTimeout(() => this.deliver(node), delay);
    this.timers.push(timer);
  }

  /** 手动/自动到达：应用包内每条记录并生成逐单回执。 */
  deliver(node) {
    if (node.state === FLIGHT.DELIVERED) return;
    node.state = FLIGHT.DELIVERED;
    node.delivered_at = Date.now();
    const outcomes = [];
    for (const record of node.packet.records) {
      const outcome = this.receiver.apply(record);
      outcomes.push({ record_id: record.record_id, job_id: record.job_id, version: record.version, op: record.op, outcome });
      this.onEvent({ type: 'record-applied', packet_id: node.packet.packet_id, ...outcomes.at(-1) });
      this.#sendAck(record, node.packet.packet_id);
    }
    this.onEvent({ type: 'packet-delivered', packet_id: node.packet.packet_id, outcomes });
  }

  #sendAck(record, packetId) {
    const ack = { record_id: record.record_id, job_id: record.job_id, ack_version: record.version, at: new Date().toISOString() };
    const node = { kind: 'ack', ack, packet_id: packetId, state: FLIGHT.FLYING, arrives_at: Date.now() + 350 };
    this.ackFlight.push(node);
    if (!this.online) {
      this.onEvent({ type: 'ack-offline-held', record_id: record.record_id });
      return;
    }
    const roll = rand();
    if (roll < this.lossRate) {
      node.state = FLIGHT.LOST;
      this.onEvent({ type: 'ack-lost', record_id: record.record_id, roll });
      return;
    }
    const timer = setTimeout(() => this.deliverAck(node), Math.max(0, node.arrives_at - Date.now()));
    this.timers.push(timer);
  }

  deliverAck(node) {
    if (node.state === FLIGHT.DELIVERED) return;
    node.state = FLIGHT.DELIVERED;
    const ok = this.sender.receiveAck(node.ack);
    this.onEvent({ type: 'ack-received', record_id: node.ack.record_id, ok });
  }

  /** 断网恢复：在途挂起的包重新进入投递（内容不变，幂等）。 */
  reconnect() {
    this.online = true;
    this.onEvent({ type: 'network-resumed' });
    for (const node of this.flight) {
      if (node.state === FLIGHT.FLYING || node.state === FLIGHT.DELAYED) this.#schedulePacket(node);
    }
    for (const node of this.ackFlight) {
      if (node.state === FLIGHT.FLYING) {
        const timer = setTimeout(() => this.deliverAck(node), 200);
        this.timers.push(timer);
      }
    }
  }

  /** 手动让一个在途/延迟/挂起包立刻到达（页面「模拟收包」）。 */
  deliverNow(packetId) {
    const node = this.flight.find(n => n.packet.packet_id === packetId && n.state !== FLIGHT.DELIVERED);
    if (node) this.deliver(node);
    return Boolean(node);
  }

  /** 收件方实收回报：按工单号返回已应用版本，用于逐单对账。 */
  receiverReport() {
    const applied = {};
    for (const [jobId, version] of this.receiver.appliedVersion) applied[jobId] = version;
    return { at: new Date().toISOString(), applied };
  }

  /** 执行一次对账：在途但实际已入表的单被确认，返回确认清单。 */
  reconcile() {
    const report = this.receiverReport();
    const confirmed = this.sender.reconcile(report);
    this.onEvent({ type: 'reconciled', report, confirmed });
    return confirmed;
  }

  pendingPackets() {
    return this.flight.filter(n => n.state !== FLIGHT.DELIVERED);
  }

  destroy() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
  }

  reset() {
    this.destroy();
    this.flight.length = 0;
    this.ackFlight.length = 0;
    this.online = true;
    this.lossRate = 0;
    this.reorder = false;
    resetRng();
  }
}

