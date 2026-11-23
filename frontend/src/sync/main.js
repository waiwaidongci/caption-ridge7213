/**
 * 排班表增量同步模拟台页面。
 * 纯前端、无登录态：引擎全部在浏览器内运行，刷新即复位。
 */
import '../sync/sync.css';
import { button, el, h, link, p } from '../utils/dom.js';
import { SyncSimulator, JOB_STATE } from './engine/simulator.js';
import { OP } from './engine/store.js';

const sim = new SyncSimulator();

const STATE_TEXT = {
  [JOB_STATE.UNPUBLISHED]: '估算未完成',
  [JOB_STATE.IN_FLIGHT]: '在途',
  [JOB_STATE.NEEDS_RETRY]: '待补（需重试）',
  [JOB_STATE.APPLIED_UNACKED]: '已生效·待回执',
  [JOB_STATE.SYNCED]: '已同步',
};
const FLIGHT_TEXT = { flying: '挂起/在途', delayed: '延迟（乱序）', lost: '已丢失', delivered: '已到达' };

function pill(text, state) { return el('span', { class: 'pill', 'data-state': state }, text); }
function num(value) { return value === null || value === undefined ? '—' : String(value); }

function renderStatus(snap) {
  const { sync } = snap;
  const badge = el('span', { class: 'syn-badge', 'data-ok': sync.in_sync ? '1' : '0' },
    el('span', { class: 'dot' }), sync.in_sync ? '同步完成：排班表与最新估算一致' : '未同步：存在差异');
  const diffs = [];
  if (sync.missing.length) diffs.push(p(`待补入表：${sync.missing.join('、')}`, 'subtle'));
  if (sync.wrong.length) diffs.push(p(`分钟数待更新：${sync.wrong.join('、')}`, 'subtle'));
  if (sync.extra.length) diffs.push(p(`待撤回（表内多余）：${sync.extra.join('、')}`, 'subtle'));
  return el('div', { class: 'sync-status-bar' }, badge,
    el('dl', { class: 'kv' },
      el('dt', {}, '最新估算应排'), el('dd', {}, `${sync.target_count} 单`),
      el('dt', {}, '排班表现排'), el('dd', {}, `${sync.table_count} 单`),
      el('dt', {}, '待确认回执'), el('dd', {}, `${sync.pending_confirm} 条`),
      el('dt', {}, '回执全收齐'), el('dd', {}, sync.fully_acked ? '是' : '否')),
    ...diffs);
}

function jobsTable(snap) {
  const head = el('tr', {}, ['工单号', '标题', '最新版本', '最新估算(分)', '表内版本', '表内分钟', '状态'].map((t, i) =>
    el('th', { scope: 'col', class: i >= 2 ? 'num' : '' }, t)));
  const body = el('tbody');
  for (const job of snap.jobs) {
    const missing = job.applied_version < job.latest_version && job.latest_version > 0;
    body.append(el('tr', { class: missing ? 'row-missing' : '' },
      el('td', {}, job.job_id),
      el('td', {}, job.estimate?.title ?? '—'),
      el('td', { class: 'num' }, num(job.latest_version || null)),
      el('td', { class: 'num' }, num(job.estimate?.estimated_minutes)),
      el('td', { class: 'num' }, num(job.applied_version || null)),
      el('td', { class: 'num' }, num(job.table_row?.estimated_minutes)),
      el('td', {}, pill(STATE_TEXT[job.state], job.state))));
  }
  return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '逐单同步状态' },
    el('table', { class: 'sync' }, el('thead', {}, head), body));
}

function effectiveAndPending(snap) {
  const effective = snap.jobs.filter(j => j.latest_version > 0 && j.applied_version >= j.latest_version);
  const pending = snap.jobs.filter(j => j.applied_version < j.latest_version);
  const chip = list => list.length
    ? el('p', {}, list.map(j => pill(`${j.job_id}（v${j.latest_version}）`, j.state)).reduce((acc, node) =>
      (acc.push(node, el('span', { class: 'help' }, ' ')), acc), []))
    : p('无', 'help');
  return el('div', { class: 'two-col' },
    el('div', {}, h(3, `已生效工单（${effective.length}）`), chip(effective)),
    el('div', {}, h(3, `待补工单（${pending.length}）`), chip(pending)));
}

function outboxTable(snap) {
  const head = el('tr', {}, ['选择', '记录', '工单', '版本', '操作', '分钟', '发送状态', '经过的包'].map(t => el('th', { scope: 'col' }, t)));
  const body = el('tbody');
  for (const row of snap.outbox) {
    const checkbox = el('input', { type: 'checkbox', value: row.record_id, class: 'outbox-pick' });
    body.append(el('tr', {},
      el('td', {}, checkbox),
      el('td', {}, row.record_id),
      el('td', {}, row.job_id),
      el('td', { class: 'num' }, String(row.version)),
      el('td', {}, pill(row.op, row.op)),
      el('td', { class: 'num' }, num(row.estimated_minutes)),
      el('td', {}, pill(row.status === 'confirmed' ? '已确认' : '待确认', row.status)),
      el('td', {}, row.packets.join('、') || '—')));
  }
  return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '发件出口' },
    el('table', { class: 'sync' }, el('thead', {}, head), body));
}

function flightTable(snap) {
  const head = el('tr', {}, ['数据包', '状态', '记录', '备注', '操作'].map(t => el('th', { scope: 'col' }, t)));
  const body = el('tbody');
  if (!snap.flight.length) body.append(el('tr', {}, el('td', { colspan: '5', class: 'help' }, '暂无在途数据包')));
  for (const row of snap.flight) {
    const canDeliver = row.state !== 'delivered';
    const deliverBtn = button('模拟收包', { class: 'quiet', disabled: !canDeliver, onClick: () => sim.deliverNow(row.packet_id) });
    body.append(el('tr', {},
      el('td', {}, row.packet_id),
      el('td', {}, pill(FLIGHT_TEXT[row.state] || row.state, row.state)),
      el('td', {}, row.records.join('、')),
      el('td', { class: 'help' }, row.note || '—'),
      el('td', {}, deliverBtn)));
  }
  return el('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': '模拟传输在途队列' },
    el('table', { class: 'sync' }, el('thead', {}, head), body));
}

function eventLog(snap) {
  const recent = snap.events.slice(-80);
  return el('div', { class: 'event-log' }, el('ol', {},
    recent.map(ev => el('li', {}, el('span', { class: 'ev-muted' }, `#${ev.seq} ${ev.type}`),
      ' ', ev.packet_id ? `[${ev.packet_id}]` : '',
      ev.record_id ? ` ${ev.record_id}` : '',
      ev.outcome ? ` → ${ev.outcome}` : '',
      ev.confirmed?.length ? ` 确认 ${ev.confirmed.join('、')}` : ''))));
}

function estimateControls(snap) {
  const jobSelect = el('select', {}, snap.jobs.map(j => el('option', { value: j.job_id },
    `${j.job_id} · ${j.estimate?.title ?? ''}`)));
  const minutes = el('input', { type: 'number', min: '0', step: '1', value: '180', class: 'mini' });
  const upsertBtn = button('发布 UPSERT（新增/改值）', { class: 'primary', onClick: () => {
    const value = Number(minutes.value);
    if (!Number.isFinite(value) || value < 0) return;
    sim.upsert(jobSelect.value, value);
  } });
  const retractBtn = button('发布 RETRACT（撤回）', { onClick: () => sim.retract(jobSelect.value) });
  const completeBtn = button('完成 QJ-N04 估算并发布', { class: 'quiet', onClick: () => sim.completeEstimate('QJ-N04', 305) });
  return el('div', { class: 'formline' },
    el('label', {}, '工单号', jobSelect),
    el('label', {}, '估算分钟', minutes),
    upsertBtn, retractBtn,
    snap.jobs.some(j => j.job_id === 'QJ-N04' && j.latest_version === 0) ? completeBtn : null);
}

function networkControls(snap) {
  const online = el('input', { type: 'checkbox', checked: snap.online });
  const reorder = el('input', { type: 'checkbox', checked: snap.reorder });
  const loss = el('input', { type: 'range', min: '0', max: '1', step: '0.1', value: String(snap.lossRate) });
  const lossLabel = el('span', { class: 'help' }, `丢包/丢回执概率 ${Math.round(snap.lossRate * 100)}%`);
  online.addEventListener('change', () => sim.configureNetwork({ online: online.checked }));
  reorder.addEventListener('change', () => sim.configureNetwork({ reorder: reorder.checked }));
  loss.addEventListener('input', () => { sim.configureNetwork({ lossRate: Number(loss.value) }); });
  return el('div', { class: 'switch-row' },
    el('label', {}, online, '在线'),
    el('label', {}, reorder, '乱序（延迟到达）'),
    el('label', {}, loss, lossLabel),
    button('断网恢复', { class: 'quiet', onClick: () => sim.reconnect() }));
}

function sendControls(root) {
  const sendAll = button('打包全部待确认增量', { class: 'primary', onClick: () => sim.send() });
  const sendPicked = button('打包勾选项', { onClick: () => {
    const ids = [...root.querySelectorAll('.outbox-pick:checked')].map(n => n.value);
    if (ids.length) sim.send(ids, '选择性分包');
  } });
  const retry = button('断网恢复·逐单补发', { onClick: () => sim.retryUnconfirmed() });
  const reconcile = button('按逐单实收对账', { class: 'quiet', onClick: () => sim.reconcile() });
  const reset = button('重置演示', { class: 'quiet', onClick: () => sim.reset() });
  return el('div', { class: 'sync-actions' }, sendAll, sendPicked, retry, reconcile, reset);
}

function render(root) {
  const snap = sim.snapshot();
  const onlinePill = pill(snap.online ? '网络在线' : '断网挂起', snap.online ? 'confirmed' : 'lost');
  root.replaceChildren(
    el('header', { class: 'sync-top' },
      el('div', {}, p('青阶讲堂 · 媒制组', 'eyeline'), h(1, '排班表增量同步模拟台'),
        p('已完成估算的待审工单按工单号发增量（新增 / 改值 / 撤回），版本逐单单调；乱序、重试、断网均可安全收敛。', 'help')),
      el('div', {}, onlinePill, ' ', link('返回工作台', '/', { class: 'back-link' }))),
    el('section', { class: 'sync-panel' }, h(2, '同步完成判定'), renderStatus(snap)),
    el('div', { class: 'sync-grid' },
      el('div', { style: 'display:grid;gap:1.15rem' },
        el('section', { class: 'sync-panel' }, h(2, '逐单状态：已生效与待补'), effectiveAndPending(snap), jobsTable(snap)),
        el('section', { class: 'sync-panel' }, h(2, '收件方排班表（已应用记录）'),
          el('div', { class: 'table-wrap' }, el('table', { class: 'sync' },
            el('thead', {}, el('tr', {}, ['工单号', '标题', '分钟', '生效版本'].map(t => el('th', { scope: 'col' }, t)))),
            el('tbody', {}, snap.table.length ? snap.table.map(r => el('tr', {},
              el('td', {}, r.job_id), el('td', {}, r.title),
              el('td', { class: 'num' }, String(r.estimated_minutes)),
              el('td', { class: 'num' }, `v${r.version}`))) : [el('tr', {}, el('td', { colspan: '4', class: 'help' }, '空表'))])))),
      el('div', { style: 'display:grid;gap:1.15rem' },
        el('section', { class: 'sync-panel' }, h(2, '估算侧操作'), estimateControls(snap)),
        el('section', { class: 'sync-panel' }, h(2, '网络模拟'), networkControls(snap),
          p('断网时发出的包挂起不丢；恢复后挂起包继续投递，再按逐单实收补发未确认项。', 'help')),
        el('section', { class: 'sync-panel' }, h(2, '发件出口（outbox）'), outboxTable(snap), sendControls(root)),
        el('section', { class: 'sync-panel' }, h(2, '模拟收包（在途数据包）'), flightTable(snap)),
        el('section', { class: 'sync-panel' }, h(2, '事件流'), eventLog(snap))))));
}

export function mountSyncPage(root) {
  sim.subscribe(() => render(root));
  render(root);
}

export { OP };
