// Managed-owner credentials live beside private engine state in a separate
// 0600 file, never in state.json, snapshots, command arguments, or logs.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { writePrivateJson } from './state.mjs';

export const SECRETS_FILE = 'game-secrets.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USERNAME = /^cp[a-z0-9]{10}$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function refuse(message) { return Object.assign(new Error(message), { statusCode: 500 }); }

/** cp + 10 random lowercase letters/digits: 12 characters, the database limit. */
export function generateUsername(bytes = randomBytes(10)) {
  return `cp${Array.from(bytes, byte => ALPHABET[byte % ALPHABET.length]).join('')}`;
}

export const generatePassword = () => randomBytes(24).toString('base64url');

export function newOwnerCredentials(at = new Date().toISOString()) {
  return { marker: randomUUID(), username: generateUsername(), password: generatePassword(), createdAt: at };
}

function validOwner(entry) {
  return entry && typeof entry === 'object' && UUID.test(entry.marker ?? '') && USERNAME.test(entry.username ?? '') &&
    typeof entry.password === 'string' && entry.password.length >= 16 && entry.password.length <= 128;
}

export function readSecrets(stateDir) {
  const file = path.join(stateDir, SECRETS_FILE);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, owners: {} }; throw error; }
  if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
  let secrets;
  try { secrets = JSON.parse(raw); } catch { throw refuse(`${SECRETS_FILE} is invalid JSON; preserve it and repair it before provisioning.`); }
  if (secrets?.version !== 1 || !secrets.owners || typeof secrets.owners !== 'object' || Array.isArray(secrets.owners)) throw refuse(`${SECRETS_FILE} has an unsupported format; refusing to replace managed-owner credentials.`);
  for (const [projectId, entry] of Object.entries(secrets.owners)) if (!validOwner(entry)) throw refuse(`${SECRETS_FILE} has an invalid entry for project ${projectId}; refusing to replace it.`);
  return secrets;
}

export function writeSecrets(stateDir, secrets) {
  writePrivateJson(path.join(stateDir, SECRETS_FILE), secrets);
}
