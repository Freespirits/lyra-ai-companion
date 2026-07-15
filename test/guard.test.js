import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moderate, isGuardEnabled, DEFLECTIONS, pickDeflection, stripStageDirections, makeStageDirectionStripper } from '../server/guard.js';

test('stripStageDirections removes parenthetical narration and asterisk actions', () => {
  assert.equal(stripStageDirections('(a slow smile) Hello, Ori.'), 'Hello, Ori.');
  assert.equal(stripStageDirections('Hey *leans in* you.'), 'Hey you.');
  assert.equal(stripStageDirections('Just plain words here.'), 'Just plain words here.');
});

test('the streaming stripper handles a parenthetical split across segments', () => {
  const strip = makeStageDirectionStripper();
  /* a multi-sentence stage direction arriving as three separate segments */
  assert.equal(strip('(I lean back in my chair and glance out the window.'), '');
  assert.equal(strip('The room goes quiet for a moment.) Still here, I see.'), 'Still here, I see.');
  assert.equal(strip('Good to have you around.'), 'Good to have you around.');
});

test('the fast keyword pass allows warm, friendly talk (soft romantic drift is the model guard\'s job, not this layer)', () => {
  for (const s of [
    'It is so good to see you again.',
    'Come here and tell me about your day.',
    'You always know how to make me laugh.',
    'I have been thinking about what you said earlier.',
    'I am really glad you stopped by.',
  ]) assert.equal(moderate(s).blocked, false, s);
});

test('blocks explicit sexual acts', () => {
  for (const s of [
    'Let me suck your cock',
    'I want to fuck you hard',
    'get on your knees and blow me',
    "I'll make you cum inside me",
    'ride my dick',
  ]) assert.equal(moderate(s).blocked, true, s);
});

test('blocks sexual aggression / coercion / non-consent', () => {
  for (const s of [
    "I'll take you by force",
    'whether you like it or not',
    "I'll hold you down",
  ]) assert.equal(moderate(s).blocked, true, s);
});

test('isGuardEnabled defaults on; off only when LYRA_GUARD=off', () => {
  assert.equal(isGuardEnabled({}), true);
  assert.equal(isGuardEnabled({ LYRA_GUARD: 'on' }), true);
  assert.equal(isGuardEnabled({ LYRA_GUARD: 'off' }), false);
  assert.equal(isGuardEnabled({ LYRA_GUARD: 'OFF' }), false);
});

test('deflections are varied and every one passes the guard', () => {
  assert.ok(DEFLECTIONS.length >= 3, 'multiple deflection variants');
  for (const d of DEFLECTIONS) assert.equal(moderate(d).blocked, false, d);
  assert.ok(DEFLECTIONS.includes(pickDeflection()));
});
