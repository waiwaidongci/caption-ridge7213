/**
 * 估算口径存储（发送方的「最新估算」事实源）。
 *
 * 只跟踪「已完成估算的待审工单」：
 *  - 估算未完成的工单不进存储，也不会被发布；
 *  - 记录值为 null 表示撤回（该工单退出排班）；
 *  - 每次发布按工单号生成 UPSERT / RETRACT 增量，版本号逐单单调递增。
 */

export const OP = Object.freeze({ UPSERT: 'UPSERT', RETRACT: 'RETRACT' });

/** 演示初始数据：四条待审工单，其中 QJ-N04 尚未完成估算。 */
export function initialEstimates() {
  return {
    'QJ-N01': { job_id: 'QJ-N01', title: '修复纸张的水分控制', estimated_minutes: 146, estimated_at: '2026-11-20 09:12', ready: true },
    'QJ-N02': { job_id: 'QJ-N02', title: '校园口述史访谈', estimated_minutes: 214, estimated_at: '2026-11-20 09:15', ready: true },
    'QJ-N03': { job_id: 'QJ-N03', title: '剪辑台上的无障碍叙事', estimated_minutes: 168, estimated_at: '2026-11-20 09:18', ready: true },
    // 尚未完成估算：不发布、不入表
    'QJ-N04': { job_id: 'QJ-N04', title: '非线性光学与量子测量', estimated_minutes: null, estimated_at: null, ready: false },
  };
}

export class EstimateStore {
  constructor(seed = initialEstimates()) {
    this.estimates = structuredClone(seed);
    /** 工单号 -> 已发布的最新版本号 */
    this.versions = new Map();
    /** 全部已发布记录（含撤回），版本号全局唯一、逐单单调 */
    this.ledger = [];
  }

  latest(jobId) {
    return this.versions.get(jobId) ?? 0;
  }

  active(jobId) {
    const item = this.estimates[jobId];
    return Boolean(item && item.ready && item.estimated_minutes !== null);
  }

  /** 当前应在排班表中的工单（已完成估算且未撤回），按工单号排序。 */
  targetEntries() {
    return Object.values(this.estimates)
      .filter(item => item.ready && item.estimated_minutes !== null)
      .map(item => ({ job_id: item.job_id, estimated_minutes: item.estimated_minutes }))
      .sort((a, b) => a.job_id.localeCompare(b.job_id));
  }

  /** 完成估算（新增）或调整估算值（改值）。 */
  upsert(jobId, minutes, title, stamp) {
    const item = this.estimates[jobId] ?? { job_id: jobId, title: title ?? jobId, estimated_minutes: null, estimated_at: null, ready: false };
    if (title) item.title = title;
    item.estimated_minutes = minutes;
    item.estimated_at = stamp ?? new Date().toISOString().slice(0, 16).replace('T', ' ');
    item.ready = true;
    this.estimates[jobId] = item;
    return this.#publish(jobId, OP.UPSERT);
  }

  /** 撤回工单：从排班表移除，但保留版本轨迹。 */
  retract(jobId, stamp) {
    const item = this.estimates[jobId];
    if (!item || !item.ready || item.estimated_minutes === null) return null; // 未入表的单无需撤回
    item.estimated_minutes = null;
    item.estimated_at = stamp ?? item.estimated_at;
    return this.#publish(jobId, OP.RETRACT);
  }

  #publish(jobId, op) {
    const version = this.latest(jobId) + 1;
    const item = this.estimates[jobId];
    const record = {
      record_id: `${jobId}#v${version}`,
      job_id: jobId,
      version,
      op,
      estimated_minutes: op === OP.UPSERT ? item.estimated_minutes : null,
      title: item.title,
      emitted_at: new Date().toISOString(),
    };
    this.versions.set(jobId, version);
    this.ledger.push(record);
    return record;
  }

  reset(seed = initialEstimates()) {
    this.estimates = structuredClone(seed);
    this.versions = new Map();
    this.ledger = [];
  }
}
