import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SESSION_COOKIE = 'ai_secretary_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

function publicAccount(account = null) {
  if (!account) return null;
  const { passwordHash, ...safe } = account;
  return safe;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, passwordHash = '') {
  const [scheme, salt, hash] = String(passwordHash).split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function parseCookie(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function buildCookie({ token = '', secret, maxAge = DEFAULT_TTL_SECONDS, secure = true } = {}) {
  const value = token ? `${token}.${sign(token, secret)}` : '';
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : ''
  ].filter(Boolean);
  return attrs.join('; ');
}

function getSignedToken(cookieHeader = '', secret) {
  const value = parseCookie(cookieHeader)[SESSION_COOKIE];
  if (!value) return '';
  const separator = value.lastIndexOf('.');
  if (separator === -1) return '';
  const token = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = sign(token, secret);
  return signature === expected ? token : '';
}

export class BetaAuthService {
  constructor({
    dbPath = process.env.AI_SECRETARY_AUTH_DB || '/data/auth/auth.sqlite',
    cookieSecret = process.env.AI_SECRETARY_COOKIE_SECRET || '',
    sessionTtlSeconds = DEFAULT_TTL_SECONDS,
    secureCookie = true,
    accessControl = null,
    clock = () => new Date()
  } = {}) {
    if (!cookieSecret || cookieSecret.length < 24) {
      throw new Error('AI_SECRETARY_COOKIE_SECRET must be at least 24 characters.');
    }
    if (!accessControl) throw new Error('BetaAuthService requires persistent accessControl.');
    this.dbPath = dbPath;
    this.cookieSecret = cookieSecret;
    this.sessionTtlSeconds = sessionTtlSeconds;
    this.secureCookie = secureCookie;
    this.accessControl = accessControl;
    this.clock = clock;
    this.db = null;
  }

  nowIso() {
    const value = new Date(this.clock());
    if (!Number.isFinite(value.getTime())) throw new Error('Authentication clock returned an invalid date.');
    return value.toISOString();
  }

  async initialize() {
    mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        displayName TEXT NOT NULL,
        passwordHash TEXT NOT NULL,
        status TEXT NOT NULL,
        role TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastLoginAt TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        accountId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        revokedAt TEXT,
        userAgent TEXT,
        ip TEXT,
        FOREIGN KEY(accountId) REFERENCES accounts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(accountId);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expiresAt);
    `);
    return this;
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  normalizeRole(role = 'user') {
    return ['admin', 'user', 'beta_user'].includes(role) ? role : 'user';
  }

  async createAccount({
    username,
    displayName,
    password,
    role = 'beta_user',
    status = 'active',
    quotaProfileId
  } = {}) {
    const safeUsername = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9_.-]{3,40}$/.test(safeUsername)) throw new Error('Username must be 3-40 lowercase letters, numbers, dot, dash or underscore.');
    if (!String(password || '').trim() || String(password).length < 8) throw new Error('Password must be at least 8 characters.');
    const account = {
      id: `acct_${crypto.randomUUID()}`,
      username: safeUsername,
      displayName: String(displayName || safeUsername).trim().slice(0, 80),
      passwordHash: hashPassword(password),
      status: status === 'disabled' ? 'disabled' : 'active',
      role: this.normalizeRole(role),
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
      lastLoginAt: null
    };
    this.db.prepare(`
      INSERT INTO accounts (id, username, displayName, passwordHash, status, role, createdAt, updatedAt, lastLoginAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(account.id, account.username, account.displayName, account.passwordHash, account.status, account.role, account.createdAt, account.updatedAt, account.lastLoginAt);
    try {
      this.accessControl.bindAccountProfile({
        accountId: account.id,
        profileId: quotaProfileId,
        enabled: account.status === 'active'
      });
    } catch (error) {
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
      throw error;
    }
    return publicAccount(account);
  }

  async findAccountByUsername(username, { includeSecret = false } = {}) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE username = ?').get(String(username || '').trim().toLowerCase());
    return includeSecret ? row || null : publicAccount(row);
  }

  getAccountById(accountId, { includeSecret = false } = {}) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?')
      .get(String(accountId || '').trim());
    return includeSecret ? row || null : publicAccount(row);
  }

  async listAccounts() {
    return this.db.prepare('SELECT id, username, displayName, status, role, createdAt, updatedAt, lastLoginAt FROM accounts ORDER BY createdAt ASC').all();
  }

  async disableAccount(username) {
    const account = await this.findAccountByUsername(username, { includeSecret: true });
    if (!account) return false;
    return this.disableAccountById(account.id);
  }

  disableAccountById(accountId) {
    const account = this.getAccountById(accountId, { includeSecret: true });
    if (!account) return false;
    const updatedAt = this.nowIso();
    this.accessControl.revokeAllSessions({
      accountId: account.id,
      reasonCode: 'ACCOUNT_DISABLED',
      enabled: false
    });
    const result = this.db.prepare('UPDATE accounts SET status = ?, updatedAt = ? WHERE id = ?')
      .run('disabled', updatedAt, account.id);
    this.db.prepare('UPDATE sessions SET revokedAt = ? WHERE accountId = ?').run(updatedAt, account.id);
    return result.changes > 0;
  }

  deleteAccountById(accountId) {
    const id = String(accountId || '').trim();
    if (!id) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM sessions WHERE accountId = ?').run(id);
      const result = this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async resetPassword(username, password) {
    if (!String(password || '').trim() || String(password).length < 8) throw new Error('Password must be at least 8 characters.');
    const account = await this.findAccountByUsername(username, { includeSecret: true });
    if (!account) return false;
    const updatedAt = this.nowIso();
    this.accessControl.revokeAllSessions({
      accountId: account.id,
      reasonCode: 'PASSWORD_RESET',
      enabled: true
    });
    const result = this.db.prepare('UPDATE accounts SET passwordHash = ?, status = ?, updatedAt = ? WHERE username = ?')
      .run(hashPassword(password), 'active', updatedAt, String(username || '').trim().toLowerCase());
    this.db.prepare('UPDATE sessions SET revokedAt = ? WHERE accountId = ?').run(updatedAt, account.id);
    return result.changes > 0;
  }

  async login({ username, password, ip = 'local', userAgent = '' } = {}) {
    const account = await this.findAccountByUsername(username, { includeSecret: true });
    let decision;
    try {
      decision = this.accessControl.getLoginDecision({
        username,
        accountId: account?.id,
        clientIp: ip
      });
    } catch {
      return { ok: false, code: 'ACCESS_CONTROL_UNAVAILABLE', message: '登录服务暂时不可用。' };
    }
    if (!decision.allowed) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        reasonCode: decision.reasonCode,
        retryAfterSeconds: decision.retryAfterSeconds,
        message: '登录失败，请稍后再试。'
      };
    }
    if (!account || account.status !== 'active' || !verifyPassword(password, account.passwordHash)) {
      let failure;
      try {
        failure = this.accessControl.recordLoginFailure({
          username,
          accountId: account?.id,
          clientIp: ip
        });
      } catch {
        return { ok: false, code: 'ACCESS_CONTROL_UNAVAILABLE', message: '登录服务暂时不可用。' };
      }
      if (!failure.allowed) {
        return {
          ok: false,
          code: 'RATE_LIMITED',
          reasonCode: failure.reasonCode,
          retryAfterSeconds: failure.retryAfterSeconds,
          message: '登录失败，请稍后再试。'
        };
      }
      return { ok: false, code: 'INVALID_CREDENTIALS', message: '用户名或密码错误。' };
    }
    const access = this.accessControl.getAccountAccess(account.id);
    if (!access?.enabled) {
      return { ok: false, code: 'INVALID_CREDENTIALS', message: '用户名或密码错误。' };
    }
    const subject = this.accessControl.createAuthenticatedSubject({
      accountId: account.id,
      role: account.role
    });
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = this.nowIso();
    const expiresAt = new Date(new Date(this.clock()).getTime() + this.sessionTtlSeconds * 1000).toISOString();
    this.db.prepare('INSERT INTO sessions (token, accountId, createdAt, expiresAt, userAgent, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, account.id, createdAt, expiresAt, String(userAgent).slice(0, 200), String(ip).slice(0, 80));
    try {
      this.accessControl.registerSession({ subject, token });
      this.accessControl.clearSuccessfulAccountLogin({
        username,
        accountId: account.id,
        clientIp: ip
      });
    } catch {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return { ok: false, code: 'ACCESS_CONTROL_UNAVAILABLE', message: '登录服务暂时不可用。' };
    }
    this.db.prepare('UPDATE accounts SET lastLoginAt = ?, updatedAt = ? WHERE id = ?').run(createdAt, createdAt, account.id);
    return {
      ok: true,
      user: publicAccount({ ...account, lastLoginAt: createdAt }),
      subject,
      setCookie: buildCookie({ token, secret: this.cookieSecret, maxAge: this.sessionTtlSeconds, secure: this.secureCookie })
    };
  }

  async getCurrentUserFromCookie(cookieHeader = '') {
    const token = getSignedToken(cookieHeader, this.cookieSecret);
    if (!token) return { user: null };
    const row = this.db.prepare(`
      SELECT a.* FROM sessions s
      JOIN accounts a ON a.id = s.accountId
      WHERE s.token = ? AND s.revokedAt IS NULL AND s.expiresAt > ? AND a.status = 'active'
    `).get(token, this.nowIso());
    if (!row) return { user: null, subject: null };
    try {
      if (!this.accessControl.validateSession({ accountId: row.id, token })) {
        return { user: null, subject: null };
      }
      return {
        user: publicAccount(row),
        subject: this.accessControl.createAuthenticatedSubject({
          accountId: row.id,
          role: row.role
        })
      };
    } catch {
      return { user: null, subject: null, code: 'ACCESS_CONTROL_UNAVAILABLE' };
    }
  }

  async logoutFromCookie(cookieHeader = '') {
    const token = getSignedToken(cookieHeader, this.cookieSecret);
    if (token) {
      const revokedAt = this.nowIso();
      this.db.prepare('UPDATE sessions SET revokedAt = ? WHERE token = ?').run(revokedAt, token);
      this.accessControl.revokeSession({ token });
    }
    return buildCookie({ token: '', secret: this.cookieSecret, maxAge: 0, secure: this.secureCookie });
  }

  async revokeAllSessionsForAccount(accountId, reasonCode = 'ADMIN_EMERGENCY_REVOKE') {
    const account = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(String(accountId || '').trim());
    if (!account) return false;
    const revokedAt = this.nowIso();
    this.accessControl.revokeAllSessions({
      accountId: account.id,
      reasonCode
    });
    this.db.prepare('UPDATE sessions SET revokedAt = ? WHERE accountId = ?').run(revokedAt, account.id);
    return true;
  }
}

export { SESSION_COOKIE, hashPassword, verifyPassword };
