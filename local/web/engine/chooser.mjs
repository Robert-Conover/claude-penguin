import { defaultProjectName, suggestPuffleName, validateProjectName, validatePuffleName } from './names.mjs';
import { statusLabels } from './ui-model.mjs';

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function copyButton(label, value, report) {
  const button = element('button', label);
  button.disabled = !value;
  button.onclick = async () => {
    try { await navigator.clipboard.writeText(value); button.textContent = 'Copied'; }
    catch { report('Copy unavailable. Select and copy the displayed text.'); }
  };
  return button;
}

function rowState(project, worker) {
  const { setup = {}, game } = project;
  if (game?.status === 'repair' || worker?.inspection?.repair) return 'Needs repair';
  if (setup.phase === 'failed') return setup.correction ? 'Puffle name rejected' : 'Setup failed';
  if (setup.phase === 'needs-worker') return 'Archived';
  if (setup.phase !== 'ready') return 'Setting up';
  return worker?.running ? 'Running' : worker?.status === 'failed' ? 'Stopped' : 'Ready';
}

export function setupChooser({ el, action, report, openWork, visit, getState }) {
  let previous = '', editedName = false, editedPuffle = false;
  const corrections = new Map();
  const addForm = el('cp-register-form');
  const name = el('cp-project-name'), path = el('cp-repo-path'), puffle = el('cp-worker-name');
  const suggest = () => suggestPuffleName([
    ...getState().snapshot.workers, ...(getState().snapshot.archivedWorkers ?? []),
  ].map(worker => worker.name)) ?? '';
  path.oninput = () => {
    if (!editedName) name.value = defaultProjectName(path.value.split('/').filter(Boolean).at(-1));
  };
  name.oninput = () => { editedName = Boolean(name.value); };
  puffle.oninput = () => { editedPuffle = Boolean(puffle.value); };
  el('cp-add-project').onclick = () => {
    addForm.hidden = !addForm.hidden;
    if (!addForm.hidden) { path.focus?.(); if (!editedPuffle) puffle.value = suggest(); }
  };
  addForm.onsubmit = async event => {
    event.preventDefault();
    try {
      const repo = path.value.trim();
      const projectName = validateProjectName(name.value || defaultProjectName(repo.split('/').filter(Boolean).at(-1)));
      const puffleName = validatePuffleName(puffle.value);
      const project = await action('register', { path: repo, name: projectName });
      if (!project?.id) throw new Error('Registration returned no project ID.');
      if (project.legacy || project.activeWorkerId) throw new Error('This repository is already registered. Use its project row.');
      await action('create', { projectId: project.id, name: puffleName });
      path.value = name.value = '';
      editedName = editedPuffle = false;
      puffle.value = suggest();
      addForm.hidden = true;
    } catch (problem) { report(problem.message); }
  };

  return function render({ snapshot, connected, busy, destinations }) {
    const max = snapshot.limits?.maxProjects ?? 32;
    el('cp-project-count').textContent = snapshot.projects.length + ' of ' + max + ' projects';
    el('cp-visitor-problem').hidden = !snapshot.visitorProblem;
    el('cp-visitor-problem').textContent = snapshot.visitorProblem ? snapshot.visitorProblem + ' Igloos will appear after the visitor verifies.' : '';
    el('cp-add-project').disabled = !connected || busy || snapshot.projects.length >= max;
    addForm.querySelector('button').disabled = el('cp-add-project').disabled;
    if (!editedPuffle) puffle.value = suggest();
    // Preserve focused correction fields across game polls and unrelated terminal activity.
    const rows = snapshot.projects.map(project => {
      const worker = snapshot.workers.find(w => w.id === project.activeWorkerId && w.projectId === project.id);
      const archives = (snapshot.archivedWorkers ?? []).filter(w => w.projectId === project.id);
      return { project, worker, archives };
    });
    const signature = JSON.stringify([rows.map(({project, worker, archives}) => [project, worker?.name, worker?.status,
      worker?.running, worker?.inspection?.repair, worker?.workspace?.sourceDirtyAtCreation, archives.map(w => w.id)]), destinations, connected, busy]);
    if (signature === previous) return;
    previous = signature;
    const list = el('cp-agent-list');
    list.replaceChildren();
    for (const {project, worker, archives} of rows) {
      const row = element('article', '', 'cp-project-row');
      const title = element('h3', project.name);
      const state = rowState(project, worker);
      const pet = worker?.name ?? project.game?.puffleName;
      const showActivity = worker?.running || ['review', 'needs-you', 'failed'].includes(worker?.status);
      row.append(title, element('p', [pet, state, showActivity && statusLabels[worker.status],
        project.sourceAvailable === false && 'Source unavailable'].filter(Boolean).join(' · ')));
      const setup = project.setup ?? {};
      for (const note of [setup.step, setup.error, worker?.inspection?.repair, setup.note ||
        (worker?.workspace?.sourceDirtyAtCreation && 'Uncommitted changes stayed in the source checkout.')].filter(Boolean)) row.append(element('p', note));
      if (project.game?.status === 'repair') row.append(element('p', project.legacy
        ? 'Restore the recorded fixture in the game database and restart the engine to verify it.'
        : 'Restore the recorded owner, igloo and puffle before retrying verification.'));
      if (!project.sourceAvailable) row.append(element('p', 'Restore the original checkout at ' + project.sourcePath));
      const buttons = element('div', '', 'cp-row-actions');
      function button(label, handler, disabled = false) {
        const b = element('button', label);
        b.disabled = disabled;
        b.onclick = async () => { try { await handler(); } catch (problem) { report(problem.message); } };
        buttons.append(b);
      }
      button('Visit', () => visit(project.id), !destinations.includes(project.id));
      button('Open work', () => openWork(project.id, worker?.id ?? null));
      if (setup.retryable && worker) {
        let input;
        if (setup.correction === 'puffleName') {
          const label = element('label', 'New puffle name');
          input = element('input', '');
          input.maxLength = 12;
          input.value = corrections.get(project.id) ?? '';
          input.oninput = () => corrections.set(project.id, input.value);
          label.append(input);
          row.append(label);
        }
        button('Retry', () => action('retry', { projectId: project.id, ...(input ? { puffleName: validatePuffleName(input.value) } : {}) }), !connected || busy);
      }
      if (!project.activeWorkerId && ['needs-worker', 'registered'].includes(setup.phase)) {
        button(project.legacy ? 'Create isolated Atlas' : 'Create puffle', () => action('create',
          { projectId: project.id, name: project.game?.puffleName ?? suggest() }), !project.sourceAvailable || !connected || busy);
      }
      for (const archived of archives) button('View archive', () => openWork(project.id, archived.id, 'archive'));
      row.append(buttons);
      list.append(row);
    }
  };
}
