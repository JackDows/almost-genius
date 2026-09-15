import { randomUUID } from 'node:crypto';
import { rankBM25 } from './vendor/cortex/Cortex.mjs';

export class ArchiveError extends Error {}
const types = ['experience', 'skill', 'project', 'memory', 'bookmark'];
function string(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ArchiveError(`${label}不能为空，最多${max}字。`);
  return value.trim();
}
export function validateEntry(input) {
  if (!input || !types.includes(input.type)) throw new ArchiveError('档案类型无效。');
  if (input.tags && (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some(t => typeof t !== 'string' || t.length > 50))) throw new ArchiveError('标签格式无效。');
  if (input.sourceIds && (!Array.isArray(input.sourceIds) || input.sourceIds.length > 100 || input.sourceIds.some(s => typeof s !== 'string' || s.length > 200))) throw new ArchiveError('来源编号无效。');
  return { type: input.type, title: string(input.title, 160, '标题'), content: string(input.content, 12000, '内容'), tags: [...new Set(input.tags || [])], sourceIds: [...new Set(input.sourceIds || [])] };
}

// 原始资料和个人档案各自保存；检索只建立派生视图，不另存一份可变的记忆数据库。
export class ArchiveService {
  constructor(store, now = () => new Date()) { this.store = store; this.now = now; }
  async initialize(profile = '') {
    if (this.store.snapshot().archive) return;
    await this.store.update(s => { s.archive = { version: 1, profile: { content: profile, revision: 1 }, items: {}, changes: [] }; });
  }
  sources() {
    const state = this.store.snapshot();
    const sources = Object.values(state.activities || {}).map(item => ({ id: item.id, source: item.source, date: item.date, title: item.title, text: item.text, url: item.url }));
    for (const [date, day] of Object.entries(state.days)) (day.notes || []).forEach((note, i) => {
      if (note.kind !== 'chat') sources.push({ id: `note:${date}:${i}`, source: '本人记录', date, title: date + ' 工作记录', text: note.text });
    });
    return sources;
  }
  list(includeDeleted = false) { return Object.values(this.store.snapshot().archive.items).filter(i => includeDeleted || !i.deletedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id) { const item = this.list(true).find(i => i.id === id); if (!item) throw new ArchiveError('没有找到这条档案。'); return item; }
  profile() { return this.store.snapshot().archive.profile; }
  async setProfile(content, revision) {
    if (typeof content !== 'string' || content.length > 20000) throw new ArchiveError('个人背景最多20000字。');
    await this.store.update(s => {
      if (s.archive.profile.revision !== revision) throw new ArchiveError('背景资料已更新，请重新读取。');
      s.archive.profile = { content, revision: revision + 1, updatedAt: this.now().toISOString() };
    });
    return this.profile();
  }
  async propose(input, origin = 'local') {
    const valid = validateEntry(input), sources = new Map(this.sources().map(s => [s.id, s]));
    if (valid.sourceIds.some(id => !sources.has(id))) throw new ArchiveError('来源不存在，请先查询工作历史并使用真实来源编号。');
    const duplicate = this.list().find(i => i.type === valid.type && i.title === valid.title && i.content === valid.content);
    if (duplicate) return duplicate;
    const at = this.now().toISOString();
    const item = { ...valid, id: randomUUID(), status: 'candidate', evidence: valid.sourceIds.map(id => sources.get(id)), origin, revision: 1, createdAt: at, updatedAt: at, deletedAt: null };
    await this.store.update(s => { s.archive.items[item.id] = item; });
    return item;
  }
  async change(id, revision, operation, input = {}) {
    await this.store.update(s => {
      const old = s.archive.items[id];
      if (!old || old.revision !== revision) throw new ArchiveError('档案不存在或已被修改，请重新读取。');
      const next = structuredClone(old);
      if (operation === 'update') {
        if (Object.keys(input).some(k => !['title', 'content', 'type', 'tags'].includes(k))) throw new ArchiveError('不能直接修改证据或确认状态。');
        Object.assign(next, validateEntry({ ...old, ...input }));
        next.status = 'candidate';
      } else if (operation === 'confirm') next.status = 'confirmed';
      else if (operation === 'delete') next.deletedAt = this.now().toISOString();
      else if (operation === 'restore') next.deletedAt = null;
      else throw new ArchiveError('档案操作无效。');
      next.revision++; next.updatedAt = this.now().toISOString();
      s.archive.items[id] = next;
      s.archive.changes.push({ id, operation, at: next.updatedAt, before: old });
      s.archive.changes = s.archive.changes.slice(-300);
    });
    return this.get(id);
  }
  search(query, includeCandidates = true) {
    if (typeof query !== 'string' || query.length > 1000) throw new ArchiveError('查询最多1000字。');
    const items = this.list().filter(i => includeCandidates || i.status === 'confirmed');
    const records = items.map(i => ({ ...i, created: i.createdAt, updated: i.updatedAt, content: `${i.title}\n${i.tags.join(' ')}\n${i.content}`, provenance: { source: i.origin } }));
    return (query.trim() ? rankBM25(records, query).filter(r => r.score > 0).map(r => r.record) : records).slice(0, 20).map(i => ({ id: i.id, type: i.type, title: i.title, status: i.status, excerpt: i.content.slice(0, 320), revision: i.revision }));
  }
  export() {
    const archive = this.store.snapshot().archive, items = this.list();
    const markdown = `# Almost Genius · 个人成长档案\n\n导出时间：${this.now().toISOString()}\n\n${archive.profile.content}\n\n` + items.map(i => `## ${i.title}\n\n${i.status === 'confirmed' ? '已确认' : '待核对'} · ${i.type}\n\n${i.content}\n\n` + i.evidence.map(e => `> ${e.date} ${e.title}\n> ${e.text.replaceAll('\n', '\n> ')}${e.url ? '\n> ' + e.url : ''}`).join('\n\n')).join('\n\n');
    return { markdown, json: JSON.stringify({ format: 'almost-genius-personal-archive', version: 1, exportedAt: this.now().toISOString(), archive, sources: this.sources() }, null, 2) };
  }
}
