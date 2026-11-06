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

test('engine snapshots, browser mappings, Flash configuration, and publication describe the same ready igloos', async t => {
  const s = sandbox(t, 'penguin-contract-');
  const stateDir = path.join(s.dir, 'state');
  const publicationDir = path.join(s.dir, 'native-igloos');
  const game = fakeGame();
  const manager = await createManager({ stateDir, worktreeRoot: path.join(s.dir, 'worktrees'), gitEnv: s.gitEnv,
    hookBaseUrl: 'http://localhost:8081/engine/hooks', ptySpawn: () => new FakePty(), game,
    publisher: acquirePublication({ dir: publicationDir, stateDir }) });
  s.cleanup(() => manager.close());

  assert.equal(agentMappings(manager.snapshot()), null, 'no verified visitor means no agent mappings');
  const add = async (name, puffle) => {
    const project = await manager.registerProject({ path: s.repo(name) });
    await manager.createWorker({ projectId: project.id, name: puffle });
    await manager.settled(project.id);
    return project.id;
  };
  const alpha = await add('alpha-app', 'nova');
  const beta = await add('beta-app', 'Pip');
  const rejected = await add('gamma-app', 'Badword');

  const snapshot = manager.snapshot();
  assert.equal(snapshot.projects.find(project => project.id === rejected).setup.correction, 'puffleName');
  const mappings = agentMappings(snapshot);
  assert.equal(mappings.visitor.penguinId, game.db.visitorId);
  assert.deepEqual(mappings.projects.map(item => item.projectId).sort(), [alpha, beta].sort(), 'only ready mappings are usable');
  for (const item of mappings.projects) {
    const project = snapshot.projects.find(entry => entry.id === item.projectId);
    const worker = snapshot.workers.find(entry => entry.id === project.activeWorkerId);
    assert.equal(item.puffleName, worker.name, 'the adopted, normalized name is the worker name');
    assert.equal(item.roomId, item.ownerId + 2000);
  }

  const published = JSON.parse(fs.readFileSync(path.join(publicationDir, 'published.json'), 'utf8'));
  assert.deepEqual(published, { version: 1, visitorId: mappings.visitor.penguinId,
    igloos: mappings.projects.map(({ ownerId, iglooId }) => ({ ownerId, iglooId })) });

  const flash = JSON.stringify(flashConfiguration(mappings));
  const secrets = Object.values(JSON.parse(fs.readFileSync(path.join(stateDir, SECRETS_FILE), 'utf8')).owners)
    .flatMap(owner => [owner.username, owner.password, owner.marker]);
  const privateValues = [...secrets, s.dir, ...snapshot.workers.map(worker => worker.sessionId)];
  for (const value of privateValues) {
    assert.equal(flash.includes(value), false, 'Flash receives only public game IDs');
    assert.equal(JSON.stringify(mappings).includes(value), false, 'browser mappings carry no paths, sessions, or credentials');
  }
});
