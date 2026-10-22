#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BetaAuthService } from '../core/auth/betaAuthService.js';
import { AccessControlService } from '../server/access/accessControlService.js';
import { AccessControlStore } from '../server/access/accessControlStore.js';
import { resolveAccessControlConfig, resolveBetaAuthDbPath } from './beta-auth-config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

async function promptPassword(label = 'Password: ') {
  if (!input.isTTY) {
    let raw = '';
    for await (const chunk of input) raw += chunk;
    return raw.trim();
  }
  output.write(label);
  input.setRawMode(true);
  let password = '';
  return new Promise((resolve) => {
    const onData = (buffer) => {
      const char = buffer.toString('utf8');
      if (char === '\r' || char === '\n') {
        input.setRawMode(false);
        input.off('data', onData);
        output.write('\n');
        resolve(password);
        return;
      }
      if (char === '\u0003') process.exit(130);
      if (char === '\b' || char === '\x7f') {
        password = password.slice(0, -1);
        return;
      }
      password += char;
    };
    input.on('data', onData);
  });
}

async function main() {
  const command = process.argv[2] || 'help';
  const accessConfig = resolveAccessControlConfig({ projectRoot });
  const accessStore = new AccessControlStore({
    dbPath: accessConfig.dbPath
  }).initialize();
  const accessControl = new AccessControlService({
    store: accessStore,
    hmacSecret: process.env.AI_SECRETARY_COOKIE_SECRET || 'cli-placeholder-secret-at-least-24'
  });
  const service = new BetaAuthService({
    dbPath: resolveBetaAuthDbPath({ projectRoot }),
    cookieSecret: process.env.AI_SECRETARY_COOKIE_SECRET || 'cli-placeholder-secret-at-least-24',
    accessControl
  });
  await service.initialize();
  try {
    if (command === 'create') {
      const username = arg('username');
      const displayName = arg('display-name', username);
      const role = arg('role', 'beta_user');
      const quotaProfileId = arg('quota-profile');
      if (!quotaProfileId) throw new Error('--quota-profile is required.');
      const password = await promptPassword('New password: ');
      const account = await service.createAccount({
        username,
        displayName,
        role,
        password,
        quotaProfileId
      });
      console.log(`created ${account.username} (${account.role})`);
      return;
    }
    if (command === 'disable') {
      const username = arg('username');
      await service.disableAccount(username);
      console.log(`disabled ${username}`);
      return;
    }
    if (command === 'reset-password') {
      const username = arg('username');
      const password = await promptPassword('New password: ');
      await service.resetPassword(username, password);
      console.log(`password reset for ${username}`);
      return;
    }
    if (command === 'list') {
      const accounts = await service.listAccounts();
      console.table(accounts.map(({ id, username, displayName, role, status, createdAt, lastLoginAt }) => ({
        id, username, displayName, role, status, createdAt, lastLoginAt
      })));
      return;
    }
    if (command === 'bind-profile') {
      const username = arg('username');
      const quotaProfileId = arg('quota-profile');
      if (!quotaProfileId) throw new Error('--quota-profile is required.');
      const account = await service.findAccountByUsername(username);
      if (!account) throw new Error('Account not found.');
      accessControl.bindAccountProfile({
        accountId: account.id,
        profileId: quotaProfileId,
        enabled: account.status === 'active'
      });
      console.log(`profile bound for ${account.username}`);
      return;
    }
    if (command === 'revoke-sessions') {
      const username = arg('username');
      const account = await service.findAccountByUsername(username);
      if (!account) throw new Error('Account not found.');
      await service.revokeAllSessionsForAccount(account.id, 'ADMIN_EMERGENCY_REVOKE');
      console.log(`sessions revoked for ${account.username}`);
      return;
    }
    console.log(`Usage:
  node scripts/beta-auth-cli.js create --username alice --display-name "Alice" --role beta_user --quota-profile closed_beta_user_v1
  node scripts/beta-auth-cli.js disable --username alice
  node scripts/beta-auth-cli.js reset-password --username alice
  node scripts/beta-auth-cli.js bind-profile --username alice --quota-profile closed_beta_user_v1
  node scripts/beta-auth-cli.js revoke-sessions --username alice
  node scripts/beta-auth-cli.js list`);
  } finally {
    service.close();
    accessStore.close();
  }
}

main().catch((error) => {
  console.error(error.message || 'Command failed');
  process.exit(1);
});
