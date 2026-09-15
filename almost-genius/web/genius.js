export function initGenius({ request, feedback, openPage }) {
  const $ = id => document.getElementById(id);
  document.querySelector('.brand strong').textContent = 'Almost Genius';
  document.querySelector('.brand span').textContent = '个人助手 · v0.4 预览版';
  const pages = [['chat', '聊一聊'], ['tasks', '我的任务'], ['growth', '成长档案']];
  for (const [id, title] of pages) {
    const button = document.createElement('button'); button.className = 'nav'; button.dataset.page = id; button.textContent = title;
    button.onclick = () => { openPage(id); void load(id); };
    document.querySelector('.sidebar nav').append(button);
  }
  const container = document.createElement('div');
  container.innerHTML = `
  <section class="page" id="page-chat" hidden>
    <div class="page-title"><div><p class="eyebrow">ALMOST GENIUS</p><h1>聊一聊</h1><p class="subtitle">随便聊，也可以安排任务、整理工作或留存经验。企业微信和这里共用对话。</p></div></div>
    <article class="card"><div id="genius-chat" class="chat-list" aria-live="polite"></div><p id="chat-status" class="muted"></p>
      <form id="chat-form"><label for="chat-input">想说什么？</label><textarea id="chat-input" rows="3" maxlength="8000" placeholder="比如：每周五下午提醒我整理这周的学习收获" required></textarea><button class="primary">发送</button></form>
      <div id="chat-failed"></div></article>
  </section>
  <section class="page" id="page-tasks" hidden>
    <div class="page-title"><div><p class="eyebrow">TASKS</p><h1>我的任务</h1><p class="subtitle">北京时间 · 当天补执行 · 电脑休眠、关机时不唤醒</p></div><button id="task-new" class="primary">新建任务</button></div>
    <p id="tasks-status" class="banner"></p><div class="toolbar"><label><input id="tasks-deleted" type="checkbox">显示已删除</label><button id="task-undo" class="text-button">撤销最后一次修改</button></div>
    <div id="genius-tasks" class="genius-cards"></div>
  </section>
  <section class="page" id="page-growth" hidden>
    <div class="page-title"><div><p class="eyebrow">GROWTH</p><h1>成长档案</h1><p class="subtitle">留下技能、项目经历与证据。待核对的内容，由你确认。</p></div><button id="archive-new" class="primary">添加记录</button></div>
    <details class="card"><summary>我的背景、目标与偏好</summary><form id="profile-form"><textarea id="profile-input" rows="12" maxlength="20000"></textarea><button class="primary">保存背景</button></form></details>
    <div class="toolbar"><button id="archive-extract" class="secondary">从工作历史提炼候选</button><button id="archive-export" class="secondary">导出个人档案</button><select id="archive-filter" aria-label="档案筛选"><option value="all">全部</option><option value="candidate">待核对</option><option value="confirmed">已确认</option><option value="deleted">已删除</option></select></div>
    <div id="genius-archive" class="genius-cards"></div>
  </section>
  <dialog id="task-dialog"><form id="task-form"><h2 id="task-heading">新建任务</h2>
    <label>名称<input id="task-title" maxlength="120" required></label>
    <label>要做什么<textarea id="task-instructions" rows="4" maxlength="6000" required></textarea></label>
    <label>执行方式<select id="task-action"><option value="agent">AI 根据说明执行</option><option value="reminder">直接发送提醒</option><option value="report">日报填报提醒</option><option value="jira">Jira 临期检查</option><option value="weekly">本周工作核对</option></select></label>
    <label>频率<select id="task-frequency"><option value="daily">每天</option><option value="weekly">每周</option><option value="once">仅一次</option><option value="interval">按间隔</option></select></label>
    <label id="task-times-label">时间（北京时间，多个时间用逗号分隔）<input id="task-times" value="15:00"></label>
    <fieldset id="task-weekdays"><legend>星期</legend>${['周日','周一','周二','周三','周四','周五','周六'].map((d,i)=>`<label><input type="checkbox" name="weekday" value="${i}">${d}</label>`).join('')}</fieldset>
    <label id="task-at-label">执行／起始时间（北京时间）<input type="datetime-local" id="task-at"></label>
    <label id="task-interval-label">间隔分钟<input id="task-interval" type="number" min="5" max="10080" value="60"></label>
    <label id="task-due-label">包含未来多少天到期的任务（0为仅今天）<input id="task-due" type="number" min="0" max="90" value="2"></label>
    <fieldset><legend>提醒渠道</legend><label><input type="checkbox" name="channel" value="local" checked>本机</label><label><input type="checkbox" name="channel" value="wecom" checked>企业微信</label></fieldset>
    <fieldset id="task-tools"><legend>允许 AI 使用的内容</legend>${[['archive.search','搜索成长档案'],['archive.get','读取档案全文'],['archive.propose','保存待核对候选'],['history.query','查看工作历史'],['jira.search','查询 Jira 临期任务'],['web.search','网页阅读与搜索']].map(([id,t])=>`<label><input type="checkbox" name="capability" value="${id}">${t}</label>`).join('')}</fieldset>
    <label><input id="task-incomplete" type="checkbox">今日已填报后不再执行</label>
    <label>错过时间时<select id="task-missed"><option value="today">当天运行／联网后补执行</option><option value="skip">跳过这次</option></select></label>
    <label><input id="task-enabled" type="checkbox" checked>启用任务</label>
    <p id="task-error" role="alert"></p><div class="toolbar"><button class="primary">保存</button><button type="button" class="secondary" id="task-close">取消</button></div>
  </form></dialog>
  <dialog id="archive-dialog"><form id="archive-form"><h2>个人成长记录</h2><label>类型<select id="archive-type"><option value="experience">经验</option><option value="skill">技能</option><option value="project">项目</option><option value="memory">偏好／记忆</option><option value="bookmark">收藏链接</option></select></label><label>标题<input id="archive-title" required maxlength="160"></label><label>内容<textarea id="archive-content" rows="8" required maxlength="12000"></textarea></label><label>标签（用逗号分隔）<input id="archive-tags"></label><p>保存后为待核对；已有证据会保留。</p><p id="archive-error" role="alert"></p><div class="toolbar"><button class="primary">保存</button><button type="button" id="archive-close" class="secondary">取消</button></div></form></dialog>`;
  document.querySelector('.content').append(container);
  let taskItems = [], archiveItems = [], editedTask = null, editedArchive = null, profileRevision = 1, stamp = {}, loading = false;
  function node(tag, text, cls) { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; }
  function button(text, callback) { const b = node('button', text, 'text-button'); b.onclick = callback; return b; }
  function linkedText(parent, text) {
    // 只把明确的 HTTP(S) URL 变为链接，不将模型输出当成 HTML 执行。
    const pieces = String(text).split(/(https?:\/\/[^\s<>"，。；）)\]]+)/g);
    for (const part of pieces) {
      if (/^https?:\/\//.test(part)) { try { const url = new URL(part); if (url.username || url.password) throw new Error(); const a = node('a', part); a.href = url.href; a.target = '_blank'; a.rel = 'noreferrer'; parent.append(a); continue; } catch {} }
      parent.append(document.createTextNode(part));
    }
  }
  const when = value => value ? new Date(value).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false}) : '无后续安排';
  const scheduleText = task => task.schedule.type === 'once' ? when(task.schedule.at) : task.schedule.type === 'interval' ? `每${task.schedule.minutes}分钟` : `${task.schedule.type === 'daily' ? '每天' : task.schedule.weekdays.map(d=>['周日','周一','周二','周三','周四','周五','周六'][d]).join('、')} ${task.schedule.times.join('、')}`;
  async function mutate(endpoint, body = {}) { try { const result = await request(endpoint, body); feedback(result.message || '已保存。'); stamp = {}; await load(); return true; } catch(e) { feedback(e.message, true); return false; } }
  async function load(page) {
    page ||= pages.find(([id]) => !$('page-' + id).hidden)?.[0];
    if (!page || loading) return; loading = true;
    try {
      const data = await request({chat:'/api/chat',tasks:'/api/tasks',growth:'/api/archive'}[page]);
      const next = JSON.stringify(data); if (stamp[page] === next) return; stamp[page] = next;
      if (page === 'chat') {
        $('genius-chat').replaceChildren();
        if (!data.turns.length) $('genius-chat').append(node('p', '分享一个链接，聊聊今天，或者直接告诉我想安排什么。', 'empty'));
        for (const turn of data.turns) { const row = node('div', '', 'chat-turn ' + turn.role); row.append(node('strong', turn.role === 'user' ? '你' : 'Almost Genius')); const p = node('p', ''); linkedText(p, turn.text); row.append(p); $('genius-chat').append(row); }
        $('chat-status').textContent = data.busy ? '正在处理…你可以继续留言。' : data.notice || '';
        $('chat-failed').replaceChildren();
        for (const job of data.jobs.filter(j => j.status === 'failed')) { const row = node('p', job.error + ' '); row.append(button('重试这条消息', () => mutate('/api/chat/retry', {id:job.id}))); $('chat-failed').append(row); }
      } else if (page === 'tasks') { taskItems = data.tasks; renderTasks(); }
      else { archiveItems = data.entries; if (document.activeElement !== $('profile-input') && !$('profile-input').dataset.dirty) { $('profile-input').value = data.profile.content; profileRevision = data.profile.revision; } renderArchive(); }
    } catch(e) { feedback(e.message, true); } finally { loading = false; }
  }
  function renderTasks() {
    $('genius-tasks').replaceChildren();
    const items = taskItems.filter(t => $('tasks-deleted').checked || !t.deletedAt);
    if (!items.length) $('genius-tasks').append(node('p', '还没有任务。可以点击新建，也可以直接在聊天中安排。', 'empty'));
    for (const task of items) {
      const card = node('article', '', 'card'); const status = task.deletedAt ? '已删除' : !task.enabled ? '已暂停' : task.pauseUntil && new Date(task.pauseUntil) > new Date() ? '暂停至 ' + when(task.pauseUntil) : '已启用';
      card.append(node('span', status, 'pill'), node('h2', task.title), node('p', task.instructions), node('p', scheduleText(task) + ' · ' + task.channels.map(c=>c==='local'?'本机':'企业微信').join('、'), 'muted'), node('p', '下次：' + when(task.next), 'muted'));
      if (task.lastRun) card.append(node('p', `最近：${when(task.lastRun.at)} · ${ {pending:'等待执行',running:'AI 正在执行',ready:'等待送达',done:'已完成',failed:'执行失败',skipped:'已跳过',cancelled:'已取消'}[task.lastRun.status] || task.lastRun.status }${task.lastRun.error ? ' · ' + task.lastRun.error : ''}`, 'muted'));
      const controls = node('div', '', 'toolbar');
      const change = operation => mutate('/api/tasks/change', {id:task.id,revision:task.revision,operation});
      if (task.deletedAt) controls.append(button('恢复为暂停状态',()=>change('restore')));
      else controls.append(button('编辑',()=>editTask(task)),button(task.enabled ? '暂停' : '恢复运行',()=>change(task.enabled ? 'pause' : 'resume')),button('删除',()=>change('delete')));
      card.append(controls); $('genius-tasks').append(card);
    }
  }
  function taskVisibility() {
    const frequency = $('task-frequency').value, action = $('task-action').value;
    $('task-times-label').hidden = !['daily','weekly'].includes(frequency); $('task-weekdays').hidden = frequency !== 'weekly';
    $('task-at-label').hidden = !['once','interval'].includes(frequency); $('task-interval-label').hidden = frequency !== 'interval';
    $('task-due-label').hidden = action !== 'jira'; $('task-tools').hidden = action !== 'agent';
  }
  function editTask(task = null) {
    editedTask = task; $('task-form').reset(); $('task-error').textContent = '';
    $('task-heading').textContent = task ? '编辑任务' : '新建任务';
    if (task) {
      $('task-title').value=task.title; $('task-instructions').value=task.instructions; $('task-action').value=task.action; $('task-frequency').value=task.schedule.type; $('task-times').value=(task.schedule.times || []).join(',');
      const at = task.schedule.at || task.schedule.anchor; $('task-at').value=at ? new Date(Date.parse(at)+28800000).toISOString().slice(0,16) : '';
      $('task-interval').value=task.schedule.minutes || 60; $('task-due').value=task.dueDays; $('task-missed').value=task.missed; $('task-enabled').checked=task.enabled; $('task-incomplete').checked=task.reportIncomplete;
    }
    for (const e of document.querySelectorAll('[name=weekday]')) e.checked=task?.schedule.weekdays?.includes(Number(e.value)) || false;
    for (const e of document.querySelectorAll('[name=channel]')) e.checked=task ? task.channels.includes(e.value) : true;
    for (const e of document.querySelectorAll('[name=capability]')) e.checked=task?.tools.includes(e.value) || false;
    taskVisibility(); $('task-dialog').showModal();
  }
  $('task-form').onsubmit = async e => {
    e.preventDefault(); const type=$('task-frequency').value, schedule={type};
    if (['daily','weekly'].includes(type)) schedule.times=$('task-times').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean);
    if (type==='weekly') schedule.weekdays=[...document.querySelectorAll('[name=weekday]:checked')].map(e=>Number(e.value));
    if (type==='once') schedule.at=$('task-at').value+':00+08:00';
    if (type==='interval') { schedule.anchor=$('task-at').value+':00+08:00'; schedule.minutes=Number($('task-interval').value); }
    const task={ title:$('task-title').value,instructions:$('task-instructions').value,action:$('task-action').value,schedule,channels:[...document.querySelectorAll('[name=channel]:checked')].map(e=>e.value),tools:[...document.querySelectorAll('[name=capability]:checked')].map(e=>e.value),dueDays:Number($('task-due').value),enabled:$('task-enabled').checked,reportIncomplete:$('task-incomplete').checked,missed:$('task-missed').value };
    try { await request(editedTask ? '/api/tasks/change' : '/api/tasks/create', editedTask ? {id:editedTask.id,revision:editedTask.revision,operation:'update',patch:task} : {task}); $('task-dialog').close(); stamp.tasks=null; await load('tasks'); feedback('任务已保存。'); } catch(e) { $('task-error').textContent=e.message; }
  };
  function renderArchive() {
    $('genius-archive').replaceChildren(); const filter=$('archive-filter').value;
    const items=archiveItems.filter(i=>filter==='deleted' ? i.deletedAt : !i.deletedAt && (filter==='all' || i.status===filter));
    if (!items.length) $('genius-archive').append(node('p','还没有这类记录。可以手动添加，或从已加载的工作历史提炼候选。','empty'));
    for (const item of items) {
      const card=node('article','','card'); card.append(node('span',item.status==='confirmed'?'已确认':'待核对','pill'),node('h2',item.title));
      const p=node('p','','pre-wrap'); linkedText(p,item.content); card.append(p,node('p',item.tags.join(' · '),'muted'));
      if (item.evidence.length) { const details=node('details',''); details.append(node('summary',`${item.evidence.length} 条原始证据`)); for (const evidence of item.evidence) { const p=node('p',`${evidence.date} ${evidence.title}\n${evidence.text}\n`,'pre-wrap'); if(evidence.url) linkedText(p,evidence.url); details.append(p); } card.append(details); }
      const controls=node('div','','toolbar'), change=operation=>mutate('/api/archive/change',{id:item.id,revision:item.revision,operation});
      if (item.deletedAt) controls.append(button('恢复',()=>change('restore')));
      else { if(item.status==='candidate') controls.append(button('内容准确，确认留存',()=>change('confirm'))); controls.append(button('编辑',()=>editArchive(item)),button('删除',()=>change('delete'))); }
      card.append(controls); $('genius-archive').append(card);
    }
  }
  function editArchive(item=null) { editedArchive=item; $('archive-form').reset(); $('archive-error').textContent=''; if(item) { $('archive-type').value=item.type; $('archive-title').value=item.title; $('archive-content').value=item.content; $('archive-tags').value=item.tags.join(','); } $('archive-dialog').showModal(); }
  $('archive-form').onsubmit=async e=>{e.preventDefault(); const entry={type:$('archive-type').value,title:$('archive-title').value,content:$('archive-content').value,tags:$('archive-tags').value.split(/[,，]/).map(t=>t.trim()).filter(Boolean)}; try { await request(editedArchive?'/api/archive/change':'/api/archive/create',editedArchive?{id:editedArchive.id,revision:editedArchive.revision,operation:'update',patch:entry}:{entry}); $('archive-dialog').close(); stamp.growth=null; await load('growth'); } catch(e){$('archive-error').textContent=e.message;} };
  $('chat-form').onsubmit=async e=>{e.preventDefault(); const text=$('chat-input').value; if(await mutate('/api/chat/send',{text}) && $('chat-input').value===text) $('chat-input').value='';};
  $('profile-input').oninput=()=>{$('profile-input').dataset.dirty='true';};
  $('profile-form').onsubmit=async e=>{e.preventDefault(); if(await mutate('/api/archive/profile',{content:$('profile-input').value,revision:profileRevision})) {delete $('profile-input').dataset.dirty;stamp.growth=null;await load('growth');}};
  $('archive-extract').onclick=async()=>{if(await mutate('/api/archive/extract')) {openPage('chat');void load('chat');}};
  $('archive-export').onclick=async()=>{try{const data=await request('/api/archive/export'); for(const ext of ['markdown','json']){const url=URL.createObjectURL(new Blob([data[ext]],{type:'text/plain;charset=utf-8'})),a=node('a','');a.href=url;a.download='Almost-Genius-个人档案.'+(ext==='markdown'?'md':'json');document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}feedback('档案已导出，不包含账号密钥。');}catch(e){feedback(e.message,true);}};
  $('task-new').onclick=()=>editTask(); $('archive-new').onclick=()=>editArchive(); $('task-close').onclick=()=>$('task-dialog').close(); $('archive-close').onclick=()=>$('archive-dialog').close();
  $('task-frequency').onchange=$('task-action').onchange=taskVisibility; $('tasks-deleted').onchange=renderTasks; $('archive-filter').onchange=renderArchive; $('task-undo').onclick=()=>mutate('/api/tasks/undo');
  for (const id of ['chat-form','task-form','archive-form','profile-form']) {
    const form=$(id), submit=form.onsubmit; let submitting=false;
    form.onsubmit=async event=>{event.preventDefault();if(submitting)return;submitting=true;const button=form.querySelector('button.primary');button.disabled=true;try{await submit(event);}finally{submitting=false;button.disabled=false;}};
  }
  setInterval(()=>void load(),5000);
  return { render(status) {
    const overview=$('task-overview');
    if(overview){ overview.replaceChildren(); for(const task of status.tasks || []){const row=node('div','','timeline-row'),content=node('div','');content.append(node('strong',task.title),node('p',task.enabled?'下次 '+when(task.next):'已暂停'));row.append(node('span','','timeline-dot'),content);overview.append(row);} }
    $('tasks-status').textContent=status.work.enabled ? '提醒已启用，以下任务按各自时间运行。' : '全部定时提醒已暂停。在设置页恢复后，启用的任务才会执行。'; } };
}
