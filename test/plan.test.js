const test = require('node:test');
const assert = require('node:assert/strict');
const { Plan } = require('../dist/plan');
const { executeTool } = require('../dist/tools');

test('a local-model semicolon plan remains a checklist after the first done call', async () => {
  const plan = new Plan();
  const result = await executeTool('plan', { steps:'scaffold vite; implement world; add movement; verify gameplay' }, { plan });
  assert.match(result,/Plan set \(4 steps\)/);
  assert.match(plan.markDone(),/Next: 2. implement world/);
  assert.equal(plan.doneCount,1);
  plan.checkpoint('World.getBlock(x,y,z); next: collision');
  assert.match(plan.compactLine(),/World.getBlock/);
  const before=JSON.stringify(plan.steps);
  assert.match(await executeTool('plan',{action:'set',steps:['a','b']},{plan}),/^Error:/);
  assert.equal(JSON.stringify(plan.steps),before);
  plan.set('Inspect foo(); preserve API\nRun tests');
assert.equal(plan.steps.length,2);
    assert.equal(plan.steps[0].text,'Inspect foo(); preserve API');
  });

  test('a step records durationMs when it becomes current and then is marked done', () => {
    const p = new Plan();
    p.set('first; second');
    const now = Date.now();
    if (p.steps[0].startedAt !== undefined) assert.ok(p.steps[0].startedAt >= now - 10);
    p.markDone();
    assert.equal(p.steps[0].done, true);
    assert.ok(p.steps[0].durationMs !== undefined && p.steps[0].durationMs >= 0);
    const after = p.steps[1].startedAt;
    if (after !== undefined) assert.ok(after >= p.steps[0].startedAt);
  });

test('working checkpoints survive a JSON session round trip and do not complete a step', () => {
  const p = new Plan();
  assert.match(p.checkpoint('x'), /^Error/);
  p.set('wire entry point\nverify build');
  p.checkpoint('save.js: makeSaver(storage, size); next: replace missing imports');
  const restored = new Plan();
  restored.steps = JSON.parse(JSON.stringify(p.steps));
  assert.equal(restored.doneCount, 0);
  assert.match(restored.compactLine(), /makeSaver\(storage, size\)/);
  assert.match(restored.checkpoint('x'.repeat(2001)), /^Error/);
  assert.match(restored.modelView(), /makeSaver/);
  restored.checkpoint('replacement checkpoint');
  assert.doesNotMatch(restored.modelView(), /makeSaver/);
  restored.markDone();
  assert.doesNotMatch(restored.modelView(), /replacement checkpoint/);
  assert.equal(restored.steps[0].note, 'replacement checkpoint');
});

test('a working checkpoint accepts up to 2000 characters and rejects longer text', () => {
  const p = new Plan();
  p.set('investigate');
  assert.match(p.checkpoint('c'.repeat(2000)), /^Checkpoint saved/);
  assert.equal(p.steps[0].note.length, 2000);
  assert.match(p.checkpoint('c'.repeat(2001)), /^Error/);
  assert.equal(p.steps[0].note.length, 2000);
});

test('overlong steps are capped so the checklist stays cheap in a small window', () => {
  const p = new Plan();
  p.set('words '.repeat(80));
  assert.ok(p.steps[0].text.length <= 201, `capped, got ${p.steps[0].text.length}`);
  assert.match(p.steps[0].text, /…$/);
  assert.ok(p.steps[0].text.length < 'words '.repeat(80).length);

  const p2 = new Plan();
  p2.set('A\n' + 'z'.repeat(300));
  assert.equal(p2.steps[1].text.length, 201, 'two-hundred plus ellipsis');
  assert.doesNotMatch(p2.modelView(), /z{250}/, 'model view never carries the blob');

  const p3 = new Plan();
  p3.set('x');
  const added = p3.add('long note ' + 'y'.repeat(300));
  assert.equal(p3.steps[1].text.length, 201);
  assert.ok(added.length < 250, 'confirmation message stays short too');
  assert.ok(p3.pendingSummary().length <= 202 * 2);
});

test('short steps keep punctuation and code intact (cap only trims the overlong)', () => {
  const p = new Plan();
  p.set('Inspect foo(); preserve API\nRun tests');
  assert.equal(p.steps[0].text, 'Inspect foo(); preserve API');
  assert.equal(p.steps[1].text, 'Run tests');
});
