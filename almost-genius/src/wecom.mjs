import AiBot from '@wecom/aibot-node-sdk';
import { randomInt, randomUUID } from 'node:crypto';

export function validateCredentials(body, previous) {
  const botId = typeof body.botId === 'string' ? body.botId.trim() : '';
  const suppliedSecret = typeof body.secret === 'string' ? body.secret.trim() : '';
  const secret = suppliedSecret || (previous?.botId === botId ? previous.secret : '');
  if (!/^[A-Za-z0-9_-]{4,160}$/.test(botId)) throw new Error('请填写有效的 Bot ID。');
  if (!secret || secret.length > 512 || /\s/.test(secret)) throw new Error('请填写 Secret。');
  return { botId, secret, userId: previous?.botId === botId ? previous.userId || '' : '' };
}

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
export const createClient = credentials => new AiBot.WSClient({
  botId: credentials.botId,
  secret: credentials.secret,
  maxReconnectAttempts: -1,
  logger: quietLogger,
});

export class WecomSetup {
  constructor(store, clientFactory = createClient) {
    this.store = store;
    this.clientFactory = clientFactory;
    this.credentials = null;
    this.client = null;
    this.connection = 'not_configured';
    this.notice = '';
    this.pairCode = this.newPairCode();
    this.lastReceivedAt = null;
    this.lastReplyAt = null;
    this.lastPushAt = null;
    this.busy = false;
    this.messageQueue = Promise.resolve();
    this.seenIds = new Set();
    this.onText = null;
    this.lastReconnectAt = 0;
  }

  newPairCode() { return String(randomInt(100000, 1000000)); }

  status() {
    return {
      connection: this.connection,
      notice: this.notice,
      botId: this.credentials?.botId || '',
      hasCredentials: Boolean(this.credentials),
      paired: Boolean(this.credentials?.userId),
      pairCode: this.credentials && !this.credentials.userId ? this.pairCode : null,
      lastReceivedAt: this.lastReceivedAt,
      lastReplyAt: this.lastReplyAt,
      lastPushAt: this.lastPushAt,
      remindersEnabled: false,
    };
  }

  async initialize() {
    this.busy = true;
    try {
      const saved = await this.store.read();
      if (saved) {
        this.credentials = validateCredentials(saved, saved);
        await this.connect(this.credentials, false);
      }
    } catch {
      this.connection = 'error';
      this.notice = '读取配置或连接失败，请重新连接。';
    } finally { this.busy = false; }
  }

  async configure(body) {
    if (this.busy) throw new Error('正在连接，请稍后。');
    const credentials = validateCredentials(body, this.credentials);
    this.busy = true;
    try { await this.connect(credentials, true); }
    finally { this.busy = false; }
  }

  async connect(credentials, save) {
    const previousBotId = this.credentials?.botId;
    this.client?.disconnect();
    const client = this.clientFactory(credentials);
    this.client = client;
    this.connection = 'connecting';
    this.notice = '';
    if (previousBotId !== credentials.botId) {
      this.lastReceivedAt = this.lastReplyAt = this.lastPushAt = null;
      this.seenIds.clear();
      this.pairCode = this.newPairCode();
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      let authenticated = false;
      let persisting = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.disconnect();
        this.connection = 'error';
        this.notice = '连接失败，请检查 Bot ID、Secret 和网络，然后重试。';
        reject(new Error(this.notice));
      };
      const timer = setTimeout(fail, 25000);
      client.on('authenticated', async () => {
        if (this.client !== client) return;
        if (settled) {
          // 只允许已成功保存的连接自动恢复。
          if (authenticated) { this.connection = 'connected'; this.notice = ''; }
          return;
        }
        if (persisting) return;
        persisting = true;
        clearTimeout(timer);
        try {
          if (save) await this.store.write(credentials);
          if (settled || this.client !== client) return;
          this.credentials = credentials;
          this.connection = 'connected';
          this.notice = '';
          authenticated = true;
          settled = true;
          resolve();
        } catch { fail(); }
      });
      client.on('disconnected', () => {
        if (this.client === client && this.connection === 'connected') this.connection = 'disconnected';
      });
      client.on('reconnecting', () => {
        if (this.client === client && settled) this.connection = 'reconnecting';
      });
      client.on('error', () => {
        if (this.client !== client) return;
        if (!settled) fail();
        else this.notice = '连接出现异常，正在等待恢复；必要时重新连接。';
      });
      client.on('message.text', frame => {
        // 串行处理绑定和消息，避免两条消息同时覆盖本地记录。
        this.messageQueue = this.messageQueue.then(() => this.receive(client, frame)).catch(() => {
          this.notice = '消息处理失败，请稍后重新发送“测试”。';
        });
      });
      try { client.connect(); } catch { fail(); }
    });
  }

  async receive(client, frame) {
    if (this.client !== client || this.connection !== 'connected' || !this.credentials) return;
    const body = frame?.body;
    if (body?.chattype !== 'single' || body.aibotid !== this.credentials.botId) return;
    const userId = body.from?.userid;
    if (typeof userId !== 'string' || !userId || userId.length > 160) return;
    if (this.credentials.userId && userId !== this.credentials.userId) return;
    const text = typeof body.text?.content === 'string' ? body.text.content.trim() : '';
    const messageId = body.msgid;
    if (typeof messageId !== 'string' || !messageId || this.seenIds.has(messageId)) return;

    let response;
    if (!this.credentials.userId) {
      if (text !== `绑定 ${this.pairCode}` && text !== `绑定${this.pairCode}`) return;
      const next = { ...this.credentials, userId };
      await this.store.write(next);
      this.credentials = next;
      this.pairCode = null;
      response = '已绑定。请发送“测试”，验证消息回复。';
    } else {
      response = this.onText ? await this.onText(text, messageId) : text === '测试'
        ? '收发正常。下一步接入 Jira 并启用提醒。'
        : '当前正在连接测试，日报记录与定时提醒尚未启用。';
    }
    this.seenIds.add(messageId);
    if (this.seenIds.size > 200) this.seenIds.delete(this.seenIds.values().next().value);
    this.lastReceivedAt = new Date().toISOString();
    if (response === null) return; // 对话已入队，完成后只推送正式回复。
    try {
      await client.replyStream(frame, randomUUID(), response, true);
      this.lastReplyAt = new Date().toISOString();
    } catch (error) {
      this.seenIds.delete(messageId);
      throw error;
    }
  }

  async pushTest() {
    if (this.connection !== 'connected' || !this.credentials?.userId) throw new Error('请先连接并绑定你的企业微信账号。');
    await this.client.sendMessage(this.credentials.userId, {
      msgtype: 'markdown',
      markdown: { content: '连接测试：企业微信主动提醒已送达。' },
    });
    this.lastPushAt = new Date().toISOString();
    return { message: '测试提醒已提交，请在企业微信确认收到。' };
  }

  async push(content, { completedChunks = 0, onProgress = async () => {}, valid = () => true } = {}) {
    if (this.connection !== 'connected' || !this.credentials?.userId) throw new Error('企业微信尚未连接。');
    // 按 UTF-8 字节分段，避免中文长消息超过平台长度限制。
    const chunks = splitMessages(content);
    for (let i = completedChunks; i < chunks.length; i++) {
      if (!valid()) throw new Error('本次消息已失效。');
      await this.client.sendMessage(this.credentials.userId, { msgtype: 'markdown', markdown: { content: chunks[i] } });
      await onProgress(i + 1);
    }
    this.lastPushAt = new Date().toISOString();
  }

  async recover() {
    if (!this.credentials || this.busy || !['error', 'disconnected'].includes(this.connection) || Date.now() < this.lastReconnectAt + 60000) return;
    this.lastReconnectAt = Date.now(); this.busy = true;
    try { await this.connect(this.credentials, false); } catch {} finally { this.busy = false; }
  }

  close() { this.client?.disconnect(); }
}

export function splitMessages(content, limit = 3500) {
  const chunks = []; let current = '';
  for (const line of String(content).split('\n')) {
    if (current && Buffer.byteLength(current + '\n' + line) > limit) { chunks.push(current); current = ''; }
    if (current) current += '\n';
    for (const char of line) {
      if (Buffer.byteLength(current + char) > limit) { chunks.push(current); current = ''; }
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
