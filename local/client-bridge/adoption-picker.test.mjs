import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the owned AS3 methods with display/event doubles. Only type annotations
// are removed; the paging, row selection, layout and pending-status logic are the
// production source. The generated-module Python check covers the compiled SWF.
const source = fs.readFileSync(new URL('./ProjectAdoption.as', import.meta.url), 'utf8');
function method(name) {
  const start = source.search(new RegExp(`(?:private|public) static function ${name}\\(`));
  assert.ok(start >= 0, `Missing AS3 method ${name}`);
  const body = source.indexOf('{', start);
  let depth = 1, end = body + 1;
  for (; depth; end++) {
    assert.ok(end < source.length, `Unclosed AS3 method ${name}`);
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  return source.slice(start, end)
    .replace(/(?:private|public) static function/, 'function')
    .replace(/(\b[A-Za-z_$][\w$]*|\))\s*:\s*(?:void|int|uint|Number|Boolean|String|Object|Sprite|TextField|TextFormat|MouseEvent|TimerEvent|Event|Error|Function)\b(?!\s*\()/g, '$1');
}

const project = index => ({ projectId: `project-${index}`, name: `Project ${index}`, puffles: 0, pending: 0,
  capacity: 10, available: true, reason: '' });
function harness(count = 32) {
  const session = { connected: true, chosen: '', message: '', destinations: Array.from({ length: count }, (_, i) => project(i + 1)) };
  const notices = [], selections = [], certificates = [];
  let status = null;
  function Sprite(value) {
    if (value) return value; // AS3's checked Sprite(value) cast.
    this.children = [];
    this.listeners = new Map();
    this.x = this.y = 0;
    this.mouseEnabled = this.mouseChildren = true;
    this.graphics = { rects: [], lineStyle() {}, beginFill() {}, endFill() {},
      drawRoundRect(...values) { this.rects.push(values); } };
  }
  Sprite.prototype.addChild = function(child) { child.parent?.removeChild(child); this.children.push(child); child.parent = this; return child; };
  Sprite.prototype.removeChild = function(child) { this.children.splice(this.children.indexOf(child), 1); child.parent = null; return child; };
  Sprite.prototype.addEventListener = function(name, listener) { this.listeners.set(name, listener); };
  function TextField() { this.x = this.y = 0; }
  TextField.prototype.setTextFormat = function(format) { this.format = format; };
  function TextFormat() {}
  const context = vm.createContext({ Sprite, TextField, TextFormat, int: value => Number(value) | 0, MouseEvent: { CLICK: 'click' },
    BLUE: 0x087AC1, DARK: 0x003858, LIGHT: 0x79DEFF,
    PICKER_PAGE_SIZE: Number(source.match(/PICKER_PAGE_SIZE:int = (\d+)/)[1]),
    pickerPage: 0, pendingNotice: '', picker: null, banner: null, notice: null, pen: null, penView: new Sprite(),
    model: null, poll: null, destinationName: '',
    call(name, ...args) {
      if (name === 'session') return session;
      if (name === 'status') return status;
      if (name === 'choose') {
        const destination = session.destinations.find(item => item.projectId === args[0]);
        if (!destination) return { ok: false, message: 'That igloo is no longer registered.' };
        session.chosen = destination.projectId;
        selections.push(destination.projectId);
        return { ok: true, destination };
      }
      throw new Error(`Unexpected page call ${name}`);
    },
    showNotice(message) { notices.push(message); }, hideNotice() {}, report() {},
    certificateFor(name) { certificates.push(name); },
    projectMode() { return true; }, purchase() { throw new Error('Page call failed after sending'); },
  });
  for (const name of ['text', 'box', 'button', 'setModal', 'hidePicker', 'showPicker',
    'previousPickerPage', 'nextPickerPage', 'choose', 'closeModule', 'showBanner', 'checkPurchase', 'hook']) {
    vm.runInContext(method(name), context);
  }
  const card = () => context.picker.children[0];
  const button = label => card().children.find(child => child.children?.[0]?.text === label);
  const rows = () => card().children.filter(child => child.name?.startsWith('project-'));
  function click(target) {
    assert.ok(target, 'The control must be rendered');
    assert.notEqual(target.mouseEnabled, false, 'The control must be enabled');
    target.listeners.get('click')({ currentTarget: target });
  }
  return { context, session, notices, selections, certificates, card, button, rows, click,
    setStatus(value) { status = value; },
    open() { context.showPicker(); },
    label() { return card().children.find(child => /^Page \d+ of \d+$/.test(child.text ?? ''))?.text; } };
}

test('native picker pages through all 32 project identities and disables both end controls', () => {
  const h = harness();
  h.open();
  assert.equal(h.button('Previous').mouseEnabled, false);
  const seen = [];
  for (let page = 1; page <= 7; page++) {
    assert.equal(h.label(), `Page ${page} of 7`);
    seen.push(...h.rows().map(row => row.name));
    if (page < 7) h.click(h.button('Next'));
  }
  assert.deepEqual(seen, Array.from({ length: 32 }, (_, i) => `project-${i + 1}`));
  assert.equal(h.button('Next').mouseEnabled, false);
  h.click(h.button('Previous'));
  assert.equal(h.label(), 'Page 6 of 7');
});

test('selection uses the clicked identity after reordering; Change follows that selected project', () => {
  const h = harness();
  h.open();
  for (let i = 0; i < 6; i++) h.click(h.button('Next'));
  const selectedRow = h.rows().find(row => row.name === 'project-32');
  h.session.destinations.reverse();
  h.click(selectedRow);
  assert.deepEqual(h.selections, ['project-32']);
  assert.equal(h.context.picker, null);
  h.click(h.context.banner.children.find(child => child.children?.[0]?.text === 'Change'));
  assert.equal(h.label(), 'Page 1 of 7');
  assert.equal(h.rows()[0].name, 'project-32');
  assert.ok(h.rows()[0].children.some(child => child.text === 'Selected igloo'));
});

test('page controls clamp after destination removal and do not select a replacement row', () => {
  const h = harness();
  h.open();
  for (let i = 0; i < 6; i++) h.click(h.button('Next'));
  const removed = h.rows()[0];
  h.session.destinations = h.session.destinations.slice(0, 8);
  h.click(removed);
  assert.equal(h.selections.length, 0);
  assert.match(h.notices.at(-1), /no longer registered/);
  h.click(h.button('Previous'));
  assert.equal(h.label(), 'Page 2 of 2');
  assert.deepEqual(h.rows().map(row => row.name), ['project-6', 'project-7', 'project-8']);
  h.session.destinations = [];
  h.context.showPicker(false);
  assert.equal(h.label(), 'Page 1 of 1');
  assert.equal(h.rows().length, 0);
  assert.equal(h.button('Next').mouseEnabled, false);
  assert.equal(h.button('Previous').mouseEnabled, false);
});

test('every picker page and footer fits the 760 by 480 native stage, including notices', () => {
  for (let count = 0; count <= 32; count++) {
    for (const message of ['', 'Your puffles are offline. Waiting for the local runtime.']) {
      const h = harness(count);
      h.session.message = message;
      h.open();
      do {
        const card = h.card();
        const [, , width, height] = card.graphics.rects[1];
        assert.ok(card.x - 3 >= 0 && card.x + width + 3 <= 760, `count ${count}: horizontal card bounds`);
        assert.ok(card.y - 3 >= 0 && card.y + height + 3 <= 480, `count ${count}: vertical card bounds`);
        for (const child of card.children) {
          const rect = child.graphics?.rects[0];
          const childWidth = rect ? rect[2] : child.width;
          const childHeight = rect ? rect[3] : child.height;
          assert.ok(child.x >= 0 && child.x + childWidth <= width, `count ${count}: horizontal child bounds`);
          assert.ok(child.y >= 0 && child.y + childHeight <= height, `count ${count}: vertical child bounds`);
        }
        const lastRow = h.rows().at(-1);
        if (lastRow) assert.ok(lastRow.y + 38 < h.button('Previous').y, 'rows must not overlap the page controls');
        if (!h.button('Next').mouseEnabled) break;
        h.click(h.button('Next'));
      } while (true);
    }
  }
});

test('uncertain purchases keep polling and show each pending message once', () => {
  const h = harness();
  let stopped = 0, adopted = 0;
  h.context.poll = { stop() { stopped++; } };
  const target = { selectedPuffle: {}, puffleAdopted: { dispatch() { adopted++; } } };
  h.context.model = target;
  h.setStatus({ state: 'pending', message: 'Checking whether the game charged your coins. Do not buy again.' });
  for (let i = 0; i < 5; i++) h.context.checkPurchase({});
  assert.equal(h.notices.length, 1);
  assert.equal(stopped, 0);
  assert.equal(adopted, 0);
  assert.equal(h.context.model, target);
  h.setStatus({ state: 'pending', message: 'Still checking. Your purchase has not been repeated.' });
  h.context.checkPurchase({});
  assert.equal(h.notices.length, 2);
  h.setStatus({ state: 'done', destination: 'Project 32', receipt: { puffleId: 42, name: 'Moss', createdAt: 123 } });
  h.context.checkPurchase({});
  assert.equal(stopped, 1);
  assert.equal(adopted, 1);
  assert.equal(target.selectedPuffle.id, 42);
  assert.deepEqual(h.certificates, ['Moss']);
});

test('purchase hook fails closed without claiming that a post-send exception was uncharged', () => {
  const h = harness();
  assert.equal(h.context.hook('purchase', {}), true);
  assert.match(h.notices.at(-1), /adoption status/);
  assert.doesNotMatch(h.notices.at(-1), /nothing was charged|no coins/i);
  h.context.projectMode = () => false;
  assert.equal(h.context.hook('purchase', {}), true);
  assert.equal(h.context.hook('penReady', {}), false);
});
