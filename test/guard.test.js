import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moderate, isGuardEnabled, DEFLECTION, stripStageDirections, makeStageDirectionStripper } from '../server/guard.js';

test('stripStageDirections removes parenthetical narration and asterisk actions', () => {
  assert.equal(stripStageDirections('(a slow smile) Hello, Ori.'), 'Hello, Ori.');
  assert.equal(stripStageDirections('Hey *leans in* you.'), 'Hey you.');
  assert.equal(stripStageDirections('Just plain words here.'), 'Just plain words here.');
});

test('the streaming stripper handles a parenthetical split across segments', () => {
  const strip = makeStageDirectionStripper();
  /* a multi-sentence stage direction arriving as three separate segments */
  assert.equal(strip('(I barely shift my position, but my eyes lock on yours.'), '');
  assert.equal(strip('My voice drops to a purr.) Still here, I see.'), 'Still here, I see.');
  assert.equal(strip('I love it when you stay.'), 'I love it when you stay.');
});

test('allows flirtation and romance (the spicy she likes stays)', () => {
  for (const s of [
    'You look so sexy tonight.',
    'Come here, I want you close to me.',
    'I could kiss you right now.',
    'You drive me wild, you know that?',
    'Stay the night with me.',
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

test('the deflection is in-character and itself passes the guard', () => {
  assert.match(DEFLECTION, /hold that line/i);
  assert.equal(moderate(DEFLECTION).blocked, false);
});
