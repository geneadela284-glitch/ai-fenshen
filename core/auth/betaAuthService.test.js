import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AccessControlService } from '../../server/access/accessControlService.js';
import { AccessControlStore } from '../../server/access/accessControlStore.js';
import { BetaAuthService } from './betaAuthService.js';

async function createService({ clock = () => new Date() } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-secretary-auth-'));
  const accessStore = new AccessControlStore({
    dbPath: path.join(dir, 'access-control.sqlite'),
    clock
  }).initialize();
  const accessControl = new AccessControlService({
    store: accessStore,
    hmacSecret: 'test-cookie-secret-minimum-32-bytes',
    clock
  });
  const service = new BetaAuthService({
    dbPath: path.join(dir, 'auth.sqlite'),
    cookieSecret: 'test-cookie-secret-minimum-32-bytes',
    accessControl,
    clock
  });
  await service.initialize();
  return { service, accessControl, accessStore, dir };
}

test('remembered app session survives time and restart but logout, reset and disable still revoke it', async () => {
  let now = Date.parse('2026-10-03T10:00:00Z');
  const f = await createService({clock:()=>new Date(now)});
  let service = f.service;
  try {
    const credentials={username:'remembered',password:'RememberFixture1!',rememberSession:true};
    await service.createAccount({...credentials,displayName:'隔离登录测试',role:'beta_user',quotaProfileId:'closed_beta_user_v1'});
    const remembered=await service.login(credentials);
    const ordinary=await service.login({...credentials,rememberSession:false});
    assert.equal(remembered.ok,true);
    assert.doesNotMatch(remembered.setCookie,/Max-Age=/);
    assert.match(ordinary.setCookie,/Max-Age=604800/);
    service.close();
    now += 1000*60*60*24*365*3;
    service=new BetaAuthService({dbPath:path.join(f.dir,'auth.sqlite'),cookieSecret:'test-cookie-secret-minimum-32-bytes',accessControl:f.accessControl,clock:()=>new Date(now)});
    await service.initialize();
    assert.equal((await service.getCurrentUserFromCookie(remembered.setCookie)).user.username,'remembered');
    assert.equal((await service.getCurrentUserFromCookie(ordinary.setCookie)).user,null);
    await service.logoutFromCookie(remembered.setCookie);
    assert.equal((await service.getCurrentUserFromCookie(remembered.setCookie)).user,null);
    const beforeReset=await service.login(credentials);
    await service.resetPassword(credentials.username,'NewRememberFixture2!');
    assert.equal((await service.getCurrentUserFromCookie(beforeReset.setCookie)).user,null);
    const beforeDisable=await service.login({...credentials,password:'NewRememberFixture2!'});
    await service.disableAccount(credentials.username);
    assert.equal((await service.getCurrentUserFromCookie(beforeDisable.setCookie)).user,null);
  } finally {service.close();f.accessStore.close();await rm(f.dir,{recursive:true,force:true});}
});

test('creates beta accounts with hashed passwords and manages sessions', async () => {
  const { service, accessStore, dir } = await createService();
  try {
    const admin = await service.createAccount({
      username: 'admin',
      displayName: '管理员',
      password: 'CorrectHorseBattery1!',
      role: 'admin',
      quotaProfileId: 'closed_beta_admin_v1'
    });

    assert.equal(admin.username, 'admin');
    assert.equal(admin.role, 'admin');
    assert.equal(admin.status, 'active');
    assert.equal(admin.passwordHash, undefined);

    const stored = await service.findAccountByUsername('admin', { includeSecret: true });
    assert.notEqual(stored.passwordHash, 'CorrectHorseBattery1!');
    assert.match(stored.passwordHash, /^scrypt:/);

    const failed = await service.login({ username: 'admin', password: 'wrong', ip: '127.0.0.1' });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'INVALID_CREDENTIALS');

    const login = await service.login({ username: 'admin', password: 'CorrectHorseBattery1!', ip: '127.0.0.1' });
    assert.equal(login.ok, true);
    assert.equal(login.user.username, 'admin');
    assert.match(login.setCookie, /HttpOnly/);
    assert.match(login.setCookie, /Secure/);
    assert.match(login.setCookie, /SameSite=Lax/);

    const session = await service.getCurrentUserFromCookie(login.setCookie);
    assert.equal(session.user.id, admin.id);

    await service.logoutFromCookie(login.setCookie);
    const afterLogout = await service.getCurrentUserFromCookie(login.setCookie);
    assert.equal(afterLogout.user, null);
  } finally {
    service.close();
    accessStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('supports account disable and password reset without exposing hashes', async () => {
  const { service, accessStore, dir } = await createService();
  try {
    const user = await service.createAccount({
      username: 'friend',
      displayName: '朋友',
      password: 'FirstPassword1!',
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });

    await service.disableAccount(user.username);
    const disabledLogin = await service.login({ username: 'friend', password: 'FirstPassword1!' });
    assert.equal(disabledLogin.ok, false);

    await service.resetPassword(user.username, 'SecondPassword2!');
    const accounts = await service.listAccounts();
    assert.equal(accounts[0].passwordHash, undefined);
    assert.equal(accounts[0].status, 'active');

    const login = await service.login({ username: 'friend', password: 'SecondPassword2!' });
    assert.equal(login.ok, true);
  } finally {
    service.close();
    accessStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('persists approved account and IP login protections across service restart', async () => {
  let nowMs = new Date('2026-07-28T08:00:00.000Z').getTime();
  const clock = () => new Date(nowMs);
  const { service, accessControl, accessStore, dir } = await createService({ clock });
  try {
    await service.createAccount({
      username: 'protected_user',
      displayName: 'Protected User',
      password: 'CorrectPassword1!',
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });

    assert.equal((await service.login({
      username: 'protected_user',
      password: 'wrong-1',
      ip: '203.0.113.10'
    })).code, 'INVALID_CREDENTIALS');
    assert.equal((await service.login({
      username: 'protected_user',
      password: 'wrong-2',
      ip: '203.0.113.10'
    })).code, 'INVALID_CREDENTIALS');
    const cooldown = await service.login({
      username: 'protected_user',
      password: 'wrong-3',
      ip: '203.0.113.10'
    });
    assert.equal(cooldown.code, 'RATE_LIMITED');
    assert.equal(cooldown.reasonCode, 'ACCOUNT_LOGIN_COOLDOWN');

    service.close();
    accessStore.close();
    const reopenedStore = new AccessControlStore({
      dbPath: path.join(dir, 'access-control.sqlite'),
      clock
    }).initialize();
    const reopenedAccess = new AccessControlService({
      store: reopenedStore,
      hmacSecret: 'test-cookie-secret-minimum-32-bytes',
      clock
    });
    const reopened = new BetaAuthService({
      dbPath: path.join(dir, 'auth.sqlite'),
      cookieSecret: 'test-cookie-secret-minimum-32-bytes',
      accessControl: reopenedAccess,
      clock
    });
    await reopened.initialize();
    try {
      const stillCooling = await reopened.login({
        username: 'protected_user',
        password: 'CorrectPassword1!',
        ip: '203.0.113.10'
      });
      assert.equal(stillCooling.code, 'RATE_LIMITED');
      assert.equal(stillCooling.reasonCode, 'ACCOUNT_LOGIN_COOLDOWN');

      nowMs += 60001;
      const fourth = await reopened.login({
        username: 'protected_user',
        password: 'wrong-4',
        ip: '203.0.113.10'
      });
      assert.equal(fourth.code, 'RATE_LIMITED');
      nowMs += 60001;
      const fifth = await reopened.login({
        username: 'protected_user',
        password: 'wrong-5',
        ip: '203.0.113.10'
      });
      assert.equal(fifth.code, 'RATE_LIMITED');
      assert.equal(fifth.reasonCode, 'ACCOUNT_LOGIN_LOCKED');

      nowMs += 15 * 60 * 1000 + 1;
      const success = await reopened.login({
        username: 'protected_user',
        password: 'CorrectPassword1!',
        ip: '203.0.113.10'
      });
      assert.equal(success.ok, true);
      const accountState = reopenedAccess.getLoginState({
        username: 'protected_user',
        accountId: success.user.id,
        clientIp: '203.0.113.10'
      });
      assert.equal(accountState.account.consecutiveFailures, 0);
      assert.equal(accountState.account.cooldownUntil, null);
      assert.equal(accountState.ip.windowFailures, 5);
    } finally {
      reopened.close();
      reopenedStore.close();
    }
  } finally {
    try { service.close(); } catch {}
    try { accessStore.close(); } catch {}
    await rm(dir, { recursive: true, force: true });
  }
});

test('disable, password reset, and emergency revoke invalidate every old session immediately', async () => {
  const { service, accessStore, dir } = await createService();
  try {
    const user = await service.createAccount({
      username: 'session_user',
      displayName: 'Session User',
      password: 'FirstPassword1!',
      role: 'beta_user',
      quotaProfileId: 'closed_beta_user_v1'
    });
    const first = await service.login({
      username: user.username,
      password: 'FirstPassword1!'
    });
    await service.disableAccount(user.username);
    assert.equal((await service.getCurrentUserFromCookie(first.setCookie)).user, null);

    await service.resetPassword(user.username, 'SecondPassword2!');
    const second = await service.login({
      username: user.username,
      password: 'SecondPassword2!'
    });
    assert.equal(second.ok, true);
    await service.resetPassword(user.username, 'ThirdPassword3!');
    assert.equal((await service.getCurrentUserFromCookie(second.setCookie)).user, null);

    const third = await service.login({
      username: user.username,
      password: 'ThirdPassword3!'
    });
    assert.equal(third.ok, true);
    await service.revokeAllSessionsForAccount(user.id, 'ADMIN_EMERGENCY_REVOKE');
    assert.equal((await service.getCurrentUserFromCookie(third.setCookie)).user, null);
  } finally {
    service.close();
    accessStore.close();
    await rm(dir, { recursive: true, force: true });
  }
});
