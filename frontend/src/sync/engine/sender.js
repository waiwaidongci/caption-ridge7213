/**
 * 发送方：增量出口（outbox）。
 *
 *  - publish 一条记录即登记 outbox，状态 pending（已发出未确认也可能已入表，
 *    因此重试只能重发同一条记录，绝不重新生成新版本）；
 *  - 发件按批打包：上批没收齐不影响新批发布，随时可以再发；
 *  - 回执按 record_id 逐单确认：确认后 outbox 项转 confirmed；
 *  - 断网恢复后按「逐单实收」补发仍未确认的记录；重发带相同 record_id/version，
 *    收件方去重，不会重复入表；
 *  - 支持按工单号对账：收件方回报已应用版本，发送方据此确认在途项
 *    （回执丢失但记录实际已入表的场景）。
 */

let packetSeq = 0;

export class Sender {
  constructor(store) {
    this.store = store;
    /** record_id -> outbox 项 */
    this.outbox = new Map();
    this.packets = [];
  }

  /** 登记估算存储发布出来的一条增量记录。 */
  enqueue(record) {
    if (!record) return null;
    const item = {
      record,
      status: 'pending',       // pending | confirmed
      sent_packet_ids: [],
      acked_at: null,
    };
    this.outbox.set(record.record_id, item);
    return item;
  }

  pending() {
    return [...this.outbox.values()]
      .filter(item => item.status === 'pending')
      .sort((a, b) => a.record.record_id.localeCompare(b.record.record_id));
  }

  /**
   * 打一个增量包。recordIds 省略时取全部待确认项（补发）；
   * 指定时只装其中仍未确认的记录。
   */
  buildPacket(recordIds = null, note = '') {
    let items = this.pending();
    if (recordIds) {
      const wanted = new Set(recordIds);
      items = items.filter(item => wanted.has(item.record.record_id));
    }
    if (items.length === 0) return null;
    const packet = {
      packet_id: `PKT-${++packetSeq}`,
      sent_at: new Date().toISOString(),
      note,
      records: items.map(item => structuredClone(item.record)),
    };
    for (const item of items) item.sent_packet_ids.push(packet.packet_id);
    this.packets.push(packet);
    return packet;
  }

  /** 处理收件方逐单回执。 */
  receiveAck(ack) {
    const item = this.outbox.get(ack.record_id);
    if (!item) return false;
    if (item.status === 'confirmed') return true; // 重复回执，幂等
    if (ack.ack_version !== item.record.version) return false;
    item.status = 'confirmed';
    item.acked_at = new Date().toISOString();
    return true;
  }

  /**
   * 按收件方回报的逐单实收版本对账：
   * 已应用版本 >= 在途记录版本即可确认（在途包丢失回执但实际已入表）。
   */
  reconcile(report) {
    const confirmed = [];
    for (const item of this.pending()) {
      const seen = report.applied[item.record.job_id] ?? 0;
      if (seen >= item.record.version) {
        item.status = 'confirmed';
        item.acked_at = new Date().toISOString();
        confirmed.push(item.record.record_id);
      }
    }
    return confirmed;
  }

  /** 已确认的最新版本，逐单返回。 */
  confirmedVersions() {
    const result = new Map();
    for (const item of this.outbox.values()) {
      if (item.status !== 'confirmed') continue;
      const cur = result.get(item.record.job_id) ?? 0;
      if (item.record.version > cur) result.set(item.record.job_id, item.record.version);
    }
    return result;
  }

  reset(store) {
    this.store = store;
    this.outbox.clear();
    this.packets.length = 0;
    packetSeq = 0;
  }
}
