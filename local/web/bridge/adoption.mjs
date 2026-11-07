// Page side of project adoption (agent page only). The derived Pet Shop module
// (local/client-bridge/ProjectAdoption.as) calls these methods synchronously
// through ExternalInterface; anything slow runs here asynchronously and the
// module polls `status()`. The purchase itself is sent by the AVM1 overlay
// (`cpBridgeAdopt`), and its reply is reported to the host engine, which
// confirms the receipt independently before binding the puffle to a worker.
import { MAX_PUFFLES_PER_IGLOO, catalogEntry, catalogForPuffleType } from '../engine/catalog.mjs';

const REPLY_TIMEOUT_MS = 20000;
const MESSAGES = {
  401: 'You need more coins to adopt this puffle.', 441: 'That name is not allowed. Try another.',
  440: 'This igloo already has 10 puffles.', expired: 'That took too long. Please try again.',
  'owner-online': 'The igloo is busy for a moment. Please try again.', 'unknown-adoption': 'Something went wrong. Please try again.',
  'unknown-puffle': 'Only the ten colors, the Blue Dog and the Orange Cat can join a project igloo.', conflict: 'Something went wrong. Please try again.',
  failed: 'Something went wrong. Check your purchase before trying again.',
  unknown: 'Your purchase is not confirmed yet. Checking again; please do not buy it again. You can also use Check purchase in Your Igloos.',
  disconnected: 'Your puffles are offline. Waiting for the local runtime.', busy: 'Another adoption is still open.',
  'not-charged': 'That adoption did not go through, and nothing was charged. You can adopt again.',
  settled: 'That adoption did not go through, and nothing was charged. You can adopt again.',
};
// These replies establish that this request was refused before charging
// (`settled`: the game database holds a committed settlement for this ID, so it
// can never charge). Other errors can follow a committed transaction or a lost
// earlier success reply.
const REFUSED = new Set(['401', '441', '440', 'owner-online', 'unknown-puffle', 'settled']);
const PENDING = ['reserving', 'sent', 'checking', 'unknown'];
const DISPATCHED = ['sent', 'checking', 'unknown'];

export function createAdoption({ getEngine, request, overlay, travel, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let chosen = '';
  let current = null; // { projectId, typeId, subtypeId, name, phase, adoptionId, code, message, receipt, ownerId, timer }
  let travelAfterClose = null;

  function destinations() {
    const snapshot = getEngine().snapshot ?? {};
    return (snapshot.projects ?? []).map(project => {
      const capacity = project.capacity ?? { max: MAX_PUFFLES_PER_IGLOO, puffles: 0, pending: 0 };
      return { projectId: project.id, name: String(project.name ?? '').slice(0, 30), puffles: capacity.puffles, pending: capacity.pending,
        capacity: capacity.max, available: !project.adoptionBlocked, reason: String(project.adoptionBlocked ?? '').slice(0, 160) };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  function finishPhase(phase, fields = {}) {
    if (!current) return;
    clearTimer(current.timer);
    Object.assign(current, { phase, timer: null }, fields);
  }

  function scheduleCheck(attempt) {
    clearTimer(attempt.timer);
    attempt.timer = setTimer(() => checkLost(attempt), REPLY_TIMEOUT_MS);
  }

  function uncertain(attempt) {
    if (current !== attempt || !DISPATCHED.includes(attempt.phase)) return;
    finishPhase('unknown', { code: 'unknown', message: MESSAGES.unknown });
    scheduleCheck(attempt);
  }

  async function report(adoptionId, result) {
    try { await request('adoptionResult', { adoptionId, result }); }
    catch { /* The engine reconciles receipts at startup and on Retry; a receipt always wins. */ }
  }

  /** The overlay relays the world server's p#cpadopt reply. */
  function onReply(event) {
    if (!current || event?.type !== 'adoption-result' || event.adoptionId !== current.adoptionId || !DISPATCHED.includes(current.phase)) return;
    if (event.ok) {
      const receipt = { puffleId: event.puffleId, typeId: event.typeId, subtypeId: event.subtypeId, name: event.name,
        coins: event.coins, cost: event.cost, createdAt: event.createdAt };
      finishPhase('done', { receipt, code: null, message: '' });
      report(event.adoptionId, { ok: true, ...receipt });
    } else {
      const code = String(event.code ?? 'failed');
      if (!REFUSED.has(code)) { uncertain(current); return; }
      finishPhase('failed', { code, message: MESSAGES[code] ?? MESSAGES.failed });
      report(event.adoptionId, { ok: false, code });
    }
  }

  /** No reply arrived: ask the engine whether a receipt exists before saying anything. */
  async function checkLost(attempt) {
    if (current !== attempt || !['sent', 'unknown'].includes(attempt.phase)) return;
    finishPhase('checking', { code: 'unknown', message: MESSAGES.unknown });
    try {
      const result = await request('reconcile', { projectId: attempt.projectId });
      // A late world reply can resolve this attempt while the receipt lookup is
      // in flight. Never overwrite it (or a newer purchase) with an older result.
      if (current !== attempt || attempt.phase !== 'checking') return;
      const record = (result?.adoptions ?? []).find(item => item.id === attempt.adoptionId);
      if (record?.receipt) {
        const entry = catalogForPuffleType(record.receipt.puffleType);
        if (!entry) { uncertain(attempt); return; }
        // Payment is confirmed independently of worker binding/worktree setup.
        finishPhase('done', { receipt: { puffleId: record.receipt.puffleId, typeId: entry.typeId, subtypeId: entry.subtypeId, name: record.receipt.name,
          coins: record.receipt.coinsAfter, cost: record.receipt.cost, createdAt: record.receipt.createdAt }, code: null, message: '' });
        return;
      }
      // `settled` is true only once the game database committed a settlement
      // for this ID; an empty lookup or elapsed time never sets it.
      if (record?.settled === true) {
        finishPhase('failed', { code: 'not-charged', message: MESSAGES['not-charged'] });
        return;
      }
    } catch { /* A failed lookup cannot establish whether the visitor paid. */ }
    // Any other missing receipt (including an expired/withdrawn record) is not
    // a final refusal: the world transaction might still commit. Keep this operation.
    uncertain(attempt);
  }

  async function purchase(attempt) {
    try {
      const adoption = await request('adopt', { projectId: attempt.projectId, typeId: attempt.typeId, subtypeId: attempt.subtypeId, name: attempt.name });
      if (current !== attempt) { await request('cancelAdoption', { adoptionId: adoption.id }).catch(() => {}); return; }
      attempt.adoptionId = adoption.id;
      attempt.ownerId = adoption.ownerId;
      // The callback may deliver a reply synchronously, or throw after sending.
      attempt.phase = 'sent';
      const sent = overlay('cpBridgeAdopt', adoption.id, attempt.typeId, attempt.name, attempt.subtypeId);
      if (attempt.phase !== 'sent') return;
      if (sent?.ok === false) {
        finishPhase('failed', { code: 'not-sent', message: 'The purchase was not sent. Reopen the Pet Shop and try again.' });
        request('cancelAdoption', { adoptionId: adoption.id }).catch(() => {});
      } else scheduleCheck(attempt);
    } catch (problem) {
      if (current !== attempt) return;
      if (DISPATCHED.includes(attempt.phase)) { uncertain(attempt); return; }
      if (attempt.phase === 'done') return;
      if (attempt.adoptionId && attempt.phase === 'reserving') await request('cancelAdoption', { adoptionId: attempt.adoptionId }).catch(() => {});
      finishPhase('failed', { code: 'refused', message: String(problem?.message ?? MESSAGES.failed).slice(0, 200) });
    }
  }

  const api = {
    /** What the destination picker shows. */
    session() {
      const engine = getEngine();
      const visitor = engine.snapshot?.visitor;
      return { enabled: true, connected: engine.connected === true, visitorReady: Boolean(visitor), chosen,
        message: !engine.connected ? MESSAGES.disconnected : !visitor ? 'Log in as the island visitor to adopt for your igloos.' : '',
        destinations: destinations() };
    },
    choose(projectId) {
      const destination = destinations().find(item => item.projectId === projectId);
      if (!destination) return { ok: false, message: 'That igloo is no longer registered.' };
      if (!destination.available) return { ok: false, message: destination.reason };
      chosen = projectId;
      return { ok: true, destination };
    },
    /** Starts one purchase for the chosen igloo; the module then polls status(). */
    buy(typeId, subtypeId, name) {
      if (current && PENDING.includes(current.phase)) return { ok: false, message: current.message || 'Your adoption is still on its way.' };
      const engine = getEngine();
      if (!engine.connected) return { ok: false, message: MESSAGES.disconnected };
      const destination = destinations().find(item => item.projectId === chosen);
      if (!destination) return { ok: false, message: 'Choose an igloo for your puffle first.' };
      if (!destination.available) return { ok: false, message: destination.reason };
      const entry = catalogEntry(Number(typeId), Number(subtypeId));
      if (!entry) return { ok: false, message: MESSAGES['unknown-puffle'] };
      if (typeof name !== 'string' || !/^[A-Za-z]{1,12}$/.test(name)) return { ok: false, code: '441', message: MESSAGES[441] };
      current = { projectId: chosen, typeId: entry.typeId, subtypeId: entry.subtypeId, name, phase: 'reserving', adoptionId: null,
        code: null, message: '', receipt: null, ownerId: null, timer: null, destination: destination.name };
      purchase(current);
      return { ok: true };
    },
    status() {
      if (!current) return { state: 'idle' };
      const state = { reserving: 'pending', sent: 'pending', checking: 'pending', unknown: 'pending', done: 'done', failed: 'failed' }[current.phase] ?? 'pending';
      return { state, code: current.code ?? '', message: current.message ?? '', receipt: current.receipt, destination: current.destination };
    },
    /** The certificate closed: travel to the destination once the module is gone. */
    finish() {
      if (current?.phase !== 'done') return { ok: false };
      travelAfterClose = { projectId: current.projectId, puffleId: current.receipt.puffleId };
      return { ok: true };
    },
    /** The adoption module left the stage (closed, finished, or cancelled). */
    closed() {
      const pending = travelAfterClose;
      travelAfterClose = null;
      if (current?.phase === 'reserving' && current.adoptionId) request('cancelAdoption', { adoptionId: current.adoptionId }).catch(() => {});
      // A sent purchase keeps its timer and reports its reply even after the module closes.
      if (current && !DISPATCHED.includes(current.phase)) current = null;
      chosen = '';
      if (pending) setTimer(() => travel(pending.projectId, { force: true, puffleId: pending.puffleId }).catch(() => {}), 800);
      return { ok: true };
    },
    onReply,
  };
  return api;
}
