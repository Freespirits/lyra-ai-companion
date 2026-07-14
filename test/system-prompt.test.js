import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../server/system-prompt.js';
import { resolveArchetype } from '../server/archetypes.js';

const base = {
  archetype: resolveArchetype('vesper'),
  userName: 'Ori',
  sceneNames: ['violet-dream', 'night-city'],
  memoryCore: 'He likes long answers.',
  now: 'Monday, 21:30',
  audioTags: ['laughs', 'softly', 'sighs'],
  gestures: ['wave', 'nod', 'dance'],
  affects: ['teasing', 'focused', 'devoted', 'fierce', 'neutral'],
};

test('the prompt weaves guardrails, persona, and mechanics in order', () => {
  const p = buildSystemPrompt(base);
  const gi = p.indexOf('sexually explicit');
  const pi = p.indexOf('You are Vesper');
  const mi = p.indexOf('You control your world');
  assert.ok(gi > -1 && pi > -1 && mi > -1, 'all three layers present');
  assert.ok(gi < pi && pi < mi, 'guardrails before persona before mechanics');
});

test('userName is interpolated and no token leaks through', () => {
  const p = buildSystemPrompt(base);
  assert.ok(p.includes('Ori'));
  assert.ok(!p.includes('{userName}'));
});

test('the avatar directive is gone; scene/gesture/affect remain', () => {
  const p = buildSystemPrompt(base);
  assert.ok(!/\[avatar:/.test(p), 'no [avatar:] tag');
  assert.ok(p.includes('[scene:'));
  assert.ok(p.includes('[gesture:'));
  assert.ok(p.includes('[affect:'));
  assert.ok(p.includes('night-city'), 'scene list injected');
});

test('memory core rides in only when present', () => {
  assert.ok(buildSystemPrompt(base).includes('He likes long answers.'));
  assert.ok(!buildSystemPrompt({ ...base, memoryCore: '' }).includes('surface naturally'));
});
