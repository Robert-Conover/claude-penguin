// Cross-boundary contract: the real engine snapshot (fake provisioner) feeds the
// browser's mapping model, and both agree with the native igloo publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createManager } from './manager.mjs';
import { SECRETS_FILE } from './game-secrets.mjs';
import { acquirePublication } from './publication.mjs';
import { FakePty, fakeGame, sandbox } from './testing.mjs';
import { agentMappings, flashConfiguration } from '../web/bridge/model.mjs';
import { nativeMenuState } from '../web/bridge/native-menu.mjs';

test('engine snapshots, browser mappings, Flash configuration, and publication describe the same igloos and puffles', async t => {
  const s = sandbox(t, 'penguin-contract-');
  const stateDir = path.join(s.dir, 'state');
  const publicationDir = path.join(s.dir, 'native-igloos');
  const game = fakeGame();
  const manager = await createManager({ stateDir, worktreeRoot: path.join(s.dir, 'worktrees'), gitEnv: s.gitEnv,
    hookBaseUrl: 'http://localhost:8081/engine/hooks', ptySpawn: () => new FakePty(), game,
    publisher: acquirePublication({ dir: publicationDir, stateDir }) });
  s.cleanup(() => manager.close());
  const published = () => JSON.parse(fs.readFileSync(path.join(publicationDir, 'published.json'), 'utf8'));

  assert.equal(agentMappings(manager.snapshot()), null, 'no verified visitor means no agent mappings');
  const register = async name => {
    const project = await manager.registerProject({ path: s.repo(name) });
    await manager.settled(project.id);
    return project.id;
  };
  const adopt = async (projectId, name, typeId = 0, subtypeId = 0) => {
    const adoption = await manager.reserveAdoption({ projectId, typeId, subtypeId, name });
    const reply = game.purchase(published(), { adoptionId: adoption.id, typeId, subtypeId, name });
    await manager.reportAdoption({ adoptionId: adoption.id, result: reply });
    await manager.settled(projectId);
    return reply;
  };
  const alpha = await register('alpha-app');
  const beta = await register('beta-app');
  await adopt(alpha, 'nova');
  await adopt(alpha, 'rex', 0, 1006);
  game.fail.igloo = new Error('stack stopped');
  const pending = await manager.registerProject({ path: s.repo('gamma-app') });
  await manager.settled(pending.id);

  const snapshot = manager.snapshot();
  assert.equal(snapshot.projects.find(project => project.id === pending.id).setup.phase, 'failed');
  const mappings = agentMappings(snapshot);
  assert.equal(mappings.visitor.penguinId, game.db.visitorId);
  assert.deepEqual(mappings.projects.map(item => item.projectId).sort(), [alpha, beta].sort(), 'only ready mappings are usable; an empty igloo is one');
  const alphaMapping = mappings.projects.find(item => item.projectId === alpha);
  assert.deepEqual(alphaMapping.puffles.map(item => [item.name, item.color]), [['Nova', 'blue'], ['Rex', 'blue-dog']]);
  for (const puffle of alphaMapping.puffles) {
    const worker = snapshot.workers.find(entry => entry.id === puffle.workerId);
    assert.equal(worker.puffle.puffleId, puffle.puffleId, 'each mapped puffle is its own worker\'s binding');
    assert.equal(worker.name, puffle.name, 'the server-normalized name is the worker name');
  }
  assert.deepEqual(mappings.projects.find(item => item.projectId === beta).puffles, []);

  assert.deepEqual(published(), { version: 2, visitorId: mappings.visitor.penguinId,
    igloos: mappings.projects.map(({ ownerId, iglooId }) => ({ ownerId, iglooId })), adoptions: [] });

  const flash = JSON.stringify(flashConfiguration(mappings));
  const menu = JSON.stringify(nativeMenuState({ connected: true, snapshot }, mappings, { projectId: alpha, workerId: alphaMapping.puffles[0].workerId }));
  const secrets = Object.values(JSON.parse(fs.readFileSync(path.join(stateDir, SECRETS_FILE), 'utf8')).owners)
    .flatMap(owner => [owner.username, owner.password, owner.marker]);
  const privateValues = [...secrets, s.dir, ...snapshot.workers.flatMap(worker => [worker.sessionId, worker.id]), ...snapshot.adoptions.map(item => item.id)];
  for (const value of privateValues) {
    assert.equal(flash.includes(value), false, 'Flash receives only public game IDs and slots');
    assert.equal(menu.includes(value), false, 'the native card carries no worker, session, or adoption identities');
  }
  for (const value of [...secrets, s.dir, ...snapshot.workers.map(worker => worker.sessionId)]) {
    assert.equal(JSON.stringify(mappings).includes(value), false, 'browser mappings carry no paths, sessions, or credentials');
  }
});
