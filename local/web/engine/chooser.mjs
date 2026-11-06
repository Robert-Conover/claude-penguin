import { defaultProjectName, validateProjectName } from './names.mjs';
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

function projectState(project) {
  const { setup = {}, game } = project;
  if (game?.status === 'repair') return 'Needs repair';
  if (setup.phase === 'failed') return 'Setup failed';
  if (setup.phase === 'needs-worker') return 'Archived';
  if (setup.phase === 'game-pending') return 'Waiting for game provisioning';
  if (setup.phase !== 'ready') return 'Setting up';
  return 'Ready';
}

function workerState(worker) {
  if (worker.inspection?.repair) return 'Needs repair';
  if (worker.setup?.phase === 'failed') return 'Setup failed';
  if (worker.workspace?.state !== 'ready') return 'Setting up';
  if (worker.queued) return statusLabels.queued;
  return worker.running ? statusLabels[worker.status] ?? 'Running' : worker.status === 'failed' ? 'Stopped' : 'Taking a break';
}

/**
 * Your Igloos: add a repository (an empty project igloo), retry setup, and see
 * each igloo's puffles. Puffles are adopted in the game at the Pet Shop.
 */
export function setupChooser({ el, action, report, openWork, visit, getState }) {
  let previous = '', editedName = false;
  const addForm = el('cp-register-form');
  const name = el('cp-project-name'), path = el('cp-repo-path');
  path.oninput = () => {
    if (!editedName) name.value = defaultProjectName(path.value.split('/').filter(Boolean).at(-1));
  };
  name.oninput = () => { editedName = Boolean(name.value); };
  el('cp-add-project').onclick = () => {
    addForm.hidden = !addForm.hidden;
    if (!addForm.hidden) path.focus?.();
  };
  addForm.onsubmit = async event => {
    event.preventDefault();
    try {
      const repo = path.value.trim();
      const projectName = validateProjectName(name.value || defaultProjectName(repo.split('/').filter(Boolean).at(-1)));
      const project = await action('register', { path: repo, name: projectName });
      if (!project?.id) throw new Error('Registration returned no project ID.');
      path.value = name.value = '';
      editedName = false;
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
    const rows = snapshot.projects.map(project => ({
      project,
      workers: snapshot.workers.filter(worker => worker.projectId === project.id),
      archives: (snapshot.archivedWorkers ?? []).filter(worker => worker.projectId === project.id),
      adoptions: (snapshot.adoptions ?? []).filter(item => item.projectId === project.id && ['reserved', 'charged', 'conflict'].includes(item.state) && !item.expired),
    }));
    const signature = JSON.stringify([rows.map(({ project, workers, archives, adoptions }) => [project,
      workers.map(worker => [worker.id, worker.name, worker.status, worker.running, worker.queued, worker.setup, worker.inspection?.repair, worker.puffle?.color, worker.workspace?.state]),
      archives.map(worker => worker.id), adoptions.map(item => [item.id, item.state, item.error])]), destinations, connected, busy]);
    if (signature === previous) return;
    previous = signature;
    const list = el('cp-agent-list');
    list.replaceChildren();
    for (const { project, workers, archives, adoptions } of rows) {
      const row = element('article', '', 'cp-project-row');
      row.append(element('h3', project.name));
      const capacity = project.capacity ?? { max: 10, puffles: workers.length };
      row.append(element('p', [projectState(project), `${capacity.puffles} of ${capacity.max} puffles`,
        project.sourceAvailable === false && 'Source unavailable'].filter(Boolean).join(' · ')));
      const setup = project.setup ?? {};
      for (const note of [setup.step, setup.error, setup.note].filter(Boolean)) row.append(element('p', note));
      if (project.game?.status === 'repair') row.append(element('p', project.legacy
        ? 'Restore the recorded fixture in the game database and restart the engine to verify it.'
        : 'Restore the recorded owner, igloo and puffles before retrying verification.'));
      if (!project.sourceAvailable) row.append(element('p', 'Restore the original checkout at ' + project.sourcePath));
      if (!workers.length && setup.phase === 'ready' && !project.adoptionBlocked) row.append(element('p', 'Adopt puffles at the Pet Shop in the game. Each one becomes a coding puffle here.'));
      if (project.adoptionBlocked && project.legacy) row.append(element('p', project.adoptionBlocked));
      const buttons = element('div', '', 'cp-row-actions');
      function button(parent, label, handler, disabled = false) {
        const b = element('button', label);
        b.disabled = disabled;
        b.onclick = async () => { try { await handler(); } catch (problem) { report(problem.message); } };
        parent.append(b);
      }
      button(buttons, 'Visit', () => visit(project.id), !destinations.includes(project.id));
      if (setup.retryable) button(buttons, 'Retry setup', () => action('retry', { projectId: project.id }), !connected || busy);
      if (project.legacy && !workers.length && ['needs-worker', 'ready'].includes(setup.phase)) {
        button(buttons, 'Create isolated Atlas', () => action('create', { projectId: project.id }), !project.sourceAvailable || !connected || busy);
      }
      for (const archived of archives) button(buttons, 'View archive', () => openWork(project.id, archived.id, 'archive'));
      row.append(buttons);
      if (workers.length) {
        const team = element('ul', '', 'cp-puffle-list');
        for (const worker of workers) {
          const item = element('li', '', 'cp-puffle-row');
          const dot = element('span', '', 'cp-puffle-dot');
          dot.dataset.color = worker.puffle?.color ?? 'blue';
          item.append(dot, element('strong', worker.name), element('span', ' · ' + workerState(worker)));
          if (worker.setup?.phase === 'failed' && worker.setup.error) item.append(element('p', worker.setup.error));
          if (worker.inspection?.repair) item.append(element('p', worker.inspection.repair));
          const actions = element('span', '', 'cp-row-actions');
          button(actions, 'Open', () => openWork(project.id, worker.id));
          if (worker.setup?.retryable) button(actions, 'Retry', () => action('retryWorker', { projectId: project.id, workerId: worker.id }), !connected || busy);
          item.append(actions);
          team.append(item);
        }
        row.append(team);
      }
      for (const adoption of adoptions) {
        const note = element('p', adoption.state === 'conflict' ? `An adoption needs inspection: ${adoption.error}`
          : adoption.state === 'charged' ? `A purchase of ${adoption.request?.name ?? 'a puffle'} is being confirmed. ${adoption.error ?? ''}`.trim()
            : `Adopting ${adoption.request?.name ?? 'a puffle'}…`);
        row.append(note);
        if (adoption.state === 'charged') button(row, 'Check purchase', () => action('reconcile', { projectId: project.id }), !connected || busy);
      }
      list.append(row);
    }
  };
}
