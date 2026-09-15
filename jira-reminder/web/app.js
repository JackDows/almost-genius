import { runtimeView, nextReminder, issueView } from './view-state.mjs';

const $ = id => document.getElementById(id);
let token = document.querySelector('meta[name="setup-token"]').content;
let status = null;
let working = false;
let polling = false;
let kind = 'daily';
let toastTimer;
let lastNotes = '';
let lastIssues = '';
const names = { not_configured:'未配置', connecting:'连接中', connected:'已连接', disconnected:'已断开', reconnecting:'重连中', error:'连接异常' };

function feedback(text, error = false) {
  clearTimeout(toastTimer);
  $('feedback').textContent = text;
  $('feedback').className = 'toast' + (error ? ' error' : '');
  $('feedback').hidden = false;
  toastTimer = setTimeout(() => { $('feedback').hidden = true; }, error ? 10000 : 5500);
}

async function request(endpoint, body, retry = true) {
  const options = { headers: { 'x-setup-token': token }, signal: AbortSignal.timeout(body === undefined ? 6500 : 35000) };
  if (body !== undefined) { options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
  const response = await fetch(endpoint, options);
  // 后台自动恢复会轮换页面令牌。只在拒绝请求后更新令牌，不重载或丢失未提交的文字。
  if (response.status === 403 && retry) {
    const fresh = await fetch('/', { cache: 'no-store', signal: AbortSignal.timeout(6500) });
    const document = new DOMParser().parseFromString(await fresh.text(), 'text/html');
    const next = document.querySelector('meta[name="setup-token"]')?.content;
    if (/^[a-f0-9]{64}$/.test(next || '')) { token = next; return request(endpoint, body, false); }
  }
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作未完成，请稍后重试。');
  return value;
}

function time(value, withDate = false) {
  if (!value) return '尚未检查';
  return new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', ...(withDate ? {month:'2-digit',day:'2-digit'} : {}), hour:'2-digit',minute:'2-digit',hour12:false });
}

function openPage(page) {
  if (!['today','records','settings'].includes(page)) return;
  for (const element of document.querySelectorAll('.page')) element.hidden = element.id !== 'page-' + page;
  for (const button of document.querySelectorAll('.nav')) {
    const selected = button.dataset.page === page;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
  }
  $('breadcrumb').textContent = '工作台 / ' + {today:'今日工作',records:'记录与整理',settings:'设置'}[page];
  window.scrollTo({ top:0 });
}

function empty(parent, text) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = text; parent.append(p); }
function updateResult() {
  const day = status?.work?.today;
  const text = kind === 'daily' ? day?.summary : day?.weekly;
  $('result-title').textContent = kind === 'daily' ? '填报参考' : '待核对草稿';
  $('result-count').textContent = kind === 'daily' ? (text ? [...text].length + ' 字' : '≤ 50 字') : '一起核对';
  $('result-text').textContent = text || '整理结果会显示在这里。';
  $('result-hint').textContent = kind === 'daily' ? '填报完成后，回复“已填报”或点击“今日已完成”。' : '有遗漏或计划变化，继续补充内容即可。';
}

function renderIssues() {
  const view = issueView(status);
  const snapshot = JSON.stringify(view);
  $('due-count').textContent = view.checkedAt ? view.issues.length : '—';
  $('due-caption').textContent = view.checkedAt ? '已检查 · ' + time(view.checkedAt) : '15:00 自动检查';
  $('jira-check-time').textContent = view.checkedAt ? '最近检查 ' + time(view.checkedAt, true) : '分配给我的未完成任务 · 可立即检查';
  if (snapshot === lastIssues) return;
  lastIssues = snapshot;
  $('jira-issues').replaceChildren();
  if (!view.checkedAt) return empty($('jira-issues'), '尚未检查，点击右上角刷新即可查看。');
  if (!view.issues.length) return empty($('jira-issues'), '明天和后天没有即将到期的任务。');
  for (const issue of view.issues) {
    const link = document.createElement('a'); link.className = 'issue'; link.href = issue.url; link.target = '_blank'; link.rel = 'noreferrer';
    const top = document.createElement('div'); top.className = 'issue-top';
    const key = document.createElement('span'); key.className = 'issue-key'; key.textContent = issue.key;
    const due = document.createElement('span'); due.className = 'issue-due'; due.textContent = issue.due.slice(5) + ' 到期';
    const title = document.createElement('h3'); title.textContent = issue.title;
    const caption = document.createElement('div'); caption.className = 'issue-link'; caption.textContent = '在 Jira 中查看 ↗';
    top.append(key,due); link.append(top,title,caption); $('jira-issues').append(link);
  }
}

function render() {
  const work = status.work, day = work.today;
  const runtime = runtimeView(status);
  $('runtime-text').textContent = runtime.text; $('runtime-dot').className = 'dot ' + runtime.color;
  $('settings-runtime').textContent = runtime.text;
  $('today-date').textContent = work.date.replaceAll('-', '.');
  $('weekday').textContent = new Date(status.serverTime).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',weekday:'long'});
  $('today-caption').textContent = '填报、临期任务和下一次提醒，都在这里。';
  $('service-banner').hidden = !work.notice && status.connection === 'connected';
  $('service-banner').textContent = work.notice || '企业微信暂未连接，正在自动恢复。本机记录仍可使用。';
  $('completion-title').textContent = day.completed ? '今日工时已填报' : '今日工时待填报';
  $('completion-help').textContent = day.completed ? '已保存完成标记，今晚不再提醒填报。' : '填好 Jira 工时后，点击右侧按钮确认。';
  $('complete').disabled = day.completed || working;
  $('reopen').hidden = !day.completed;
  $('schedule-pill').textContent = work.enabled ? '已启用' : '已暂停';
  $('schedule-pill').className = 'pill ' + (work.enabled ? 'green' : 'amber');
  const next = nextReminder(status);
  $('next-time').textContent = next.time; $('next-description').textContent = next.description;
  $('note-count').textContent = day.notes?.length || 0;
  $('summary-preview').textContent = day.summary || '还没有整理内容。告诉我今天做了什么，生成 50 字以内的填报参考。';
  $('last-tick').textContent = work.lastTickAt ? time(work.lastTickAt, true) : '尚未到检查时间';
  $('record-date').textContent = work.date;
  $('writer-status').textContent = work.busy ? '正在整理，可先继续记录或确认填报完成。' : work.writerNotice || '';
  $('retry').hidden = !work.writerNotice;
  $('toggle-reminders').textContent = work.enabled ? '暂停提醒' : '恢复提醒';
  $('toggle-reminders').disabled = working || (!work.enabled && (!status.paired || !status.jira?.configured));
  $('jira-check').disabled = working || !status.jira?.configured;
  $('wecom-dot').className = 'dot ' + (status.connection === 'connected' ? 'green' : 'amber');
  $('wecom-side').textContent = '企业微信' + (names[status.connection] || '未连接');
  $('jira-dot').className = 'dot ' + (status.jira?.configured && !status.jira.notice ? 'green' : 'amber');
  $('jira-side').textContent = status.jira?.configured ? (status.jira.notice ? 'Jira 检查需处理' : 'Jira 已配置') : 'Jira 未配置';
  $('jira-state').textContent = status.jira?.configured ? '已配置' : '未配置';
  $('jira-status').textContent = status.jira?.configured ? status.jira.identity + ' · 所有分配给我的未完成任务' : '请填写 Jira 用户名和密码。';
  if (status.jira?.notice) $('jira-status').textContent += ' · ' + status.jira.notice;
  $('connection').textContent = names[status.connection] || '未连接';
  $('connection').className = 'pill ' + (status.connection === 'connected' ? 'green' : 'amber');
  $('pair-pending').hidden = status.paired || status.connection === 'connected';
  $('pair-ready').hidden = !status.pairCode;
  $('pair-command').textContent = status.pairCode ? '绑定 ' + status.pairCode : '';
  $('paired').hidden = !status.paired;
  $('test-push').disabled = working || !status.paired || status.connection !== 'connected';
  if (!$('bot-id').value) $('bot-id').value = status.botId || '';
  $('secret').required = !status.hasCredentials;
  $('secret').placeholder = status.hasCredentials ? '已加密保存；不修改时留空' : '填写机器人 Secret';
  const notes = JSON.stringify(day.notes || []);
  if (notes !== lastNotes) {
    lastNotes = notes; $('notes').replaceChildren();
    if (!day.notes?.length) empty($('notes'), '今天还没有工作记录。');
    for (const note of [...(day.notes || [])].reverse()) {
      const row = document.createElement('div'); row.className = 'note-row';
      const stamp = document.createElement('time'); stamp.textContent = time(note.at) + (note.kind === 'weekly' ? ' · 周计划' : ' · 日报');
      const text = document.createElement('p'); text.textContent = note.text;
      row.append(stamp,text); $('notes').append(row);
    }
  }
  renderIssues(); updateResult();
}

async function refresh() {
  if (polling) return;
  polling = true;
  try { status = await request('/api/status'); render(); }
  catch {
    $('runtime-text').textContent = '后台未连接'; $('runtime-dot').className = 'dot red';
    $('settings-runtime').textContent = '后台未连接';
    $('service-banner').hidden = false; $('service-banner').textContent = '后台暂未连接，正在自动重试。未提交的工作文字会保留在当前窗口。';
    for (const id of ['complete','jira-check','toggle-reminders','test-push']) $(id).disabled = true;
  } finally { polling = false; }
}

async function action(endpoint, body = {}) {
  if (working) return false;
  working = true;
  document.querySelectorAll('form button, #complete, #reopen, #retry, #toggle-reminders, #test-local, #test-push, #jira-check').forEach(button => { button.disabled = true; });
  try { const result = await request(endpoint,body); feedback(result.message); return true; }
  catch (error) { feedback(error.name === 'TimeoutError' ? '响应超时，请稍后查看状态。' : error.message,true); return false; }
  finally {
    working = false;
    document.querySelectorAll('form button, #reopen, #retry, #test-local').forEach(button => { button.disabled = false; });
    await refresh();
  }
}

document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => openPage(button.dataset.page)));
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => openPage(button.dataset.open)));
document.querySelectorAll('[data-kind]').forEach(button => button.addEventListener('click', () => {
  kind = button.dataset.kind;
  document.querySelectorAll('[data-kind]').forEach(item => item.classList.toggle('selected',item.dataset.kind === kind));
  $('note-label').textContent = kind === 'daily' ? '今天做了什么？' : '本周做了什么，下周准备做什么？';
  $('note-hint').textContent = kind === 'daily' ? '整理为 50 字以内，生成文字后仍需自行填报。' : '先整理草稿，再一起核对。';
  updateResult();
}));
$('complete').addEventListener('click', () => action('/api/work/complete'));
$('reopen').addEventListener('click', () => action('/api/work/reopen'));
$('retry').addEventListener('click', () => action('/api/work/retry'));
$('test-local').addEventListener('click', () => action('/api/work/test-local'));
$('test-push').addEventListener('click', () => action('/api/test-push'));
$('toggle-reminders').addEventListener('click', () => action('/api/work/enable',{enabled:!status?.work?.enabled}));
$('jira-check').addEventListener('click', () => action('/api/jira/check'));
$('note-form').addEventListener('submit', async event => { event.preventDefault(); const text = $('note').value; const selectedKind = kind; if (await action('/api/work/record',{text,kind:selectedKind}) && $('note').value === text) $('note').value = ''; });
$('jira-form').addEventListener('submit', async event => { event.preventDefault(); if (await action('/api/jira/connect',{username:$('jira-user').value,password:$('jira-password').value})) { $('jira-password').value = ''; $('jira-details').open = false; } });
$('config-form').addEventListener('submit', async event => { event.preventDefault(); if (await action('/api/connect',{botId:$('bot-id').value,secret:$('secret').value})) $('secret').value = ''; });
refresh(); setInterval(refresh,5000);
