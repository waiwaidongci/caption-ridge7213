/**
 * 收件方：排班表。
 *
 * 应用规则（乱序与重复投递下保持收敛）：
 *  - 按工单号记录已应用版本 applied_version；
 *  - record.version <= applied_version 一律丢弃（旧记录不能盖新版，重试不重复入表）；
 *  - 高版本先到、低版本后到时低版本被拒，最终以高版本状态为准；
 *  - RETRACT 应用后删除表项；被撤回的工单不会因迟到的旧 UPSERT 复活；
 *  - 应用是幂等的：同一记录重复投递结果不变，回执照常返回。
 */

export const APPLY = Object.freeze({
  APPLIED: 'applied',       // 本次新应用
  STALE: 'stale',           // 旧版本，拒绝覆盖
  DUPLICATE: 'duplicate',   // 同版本重复投递，不重复入表
});

export class ScheduleTable {
  constructor() {
    /** job_id -> 表项（仅当前应排班的工单） */
    this.entries = new Map();
    /** job_id -> 已应用版本号 */
    this.appliedVersion = new Map();
    /** job_id -> 已应用记录的操作类型，用于审计与复活拦截判断 */
    this.appliedOp = new Map();
    this.audit = [];
  }

  apply(record) {
    const known = this.appliedVersion.get(record.job_id) ?? 0;
    let outcome;
    if (record.version < known) {
      outcome = APPLY.STALE;
    } else if (record.version === known) {
      outcome = APPLY.DUPLICATE;
    } else {
      if (record.op === 'RETRACT') {
        this.entries.delete(record.job_id);
      } else {
        this.entries.set(record.job_id, {
          job_id: record.job_id,
          title: record.title,
          estimated_minutes: record.estimated_minutes,
          version: record.version,
          applied_at: new Date().toISOString(),
        });
      }
      this.appliedVersion.set(record.job_id, record.version);
      this.appliedOp.set(record.job_id, record.op);
      outcome = APPLY.APPLIED;
    }
    this.audit.push({
      record_id: record.record_id, job_id: record.job_id, version: record.version,
      op: record.op, outcome, at: new Date().toISOString(),
    });
    return outcome;
  }

  has(jobId) { return this.entries.has(jobId); }
  get(jobId) { return this.entries.get(jobId) ?? null; }
  appliedVersionOf(jobId) { return this.appliedVersion.get(jobId) ?? 0; }

  rows() {
    return [...this.entries.values()].sort((a, b) => a.job_id.localeCompare(b.job_id));
  }

  /** 与最新估算的规范集合比对：一致才算同步完成。 */
  diff(targetEntries) {
    const current = new Map(this.rows().map(r => [r.job_id, r.estimated_minutes]));
    const target = new Map(targetEntries.map(r => [r.job_id, r.estimated_minutes]));
    const missing = [];     // 表里缺、估算里有
    const wrong = [];       // 两边都有但分钟数不一致
    const extra = [];       // 表里有、估算已撤回/不存在
    for (const [jobId, minutes] of target) {
      if (!current.has(jobId)) missing.push(jobId);
      else if (current.get(jobId) !== minutes) wrong.push(jobId);
    }
    for (const jobId of current.keys()) {
      if (!target.has(jobId)) extra.push(jobId);
    }
    return {
      in_sync: missing.length === 0 && wrong.length === 0 && extra.length === 0,
      missing, wrong, extra,
    };
  }

  reset() {
    this.entries.clear();
    this.appliedVersion.clear();
    this.appliedOp.clear();
    this.audit = [];
  }
}
