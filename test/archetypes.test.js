import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHETYPES, GUARDRAILS, resolveArchetype, pickVoice } from '../server/archetypes.js';

test('there are five archetypes with body-matching ids', () => {
  assert.equal(ARCHETYPES.length, 5);
  assert.deepEqual(ARCHETYPES.map(a => a.id), ['lyra', 'nova', 'mira', 'vesper', 'kira']);
});

test('every archetype is fully populated', () => {
  for (const a of ARCHETYPES) {
    for (const k of ['name', 'tagline', 'persona', 'scene', 'affect', 'greeting', 'portrait']) {
      assert.ok(a[k] && String(a[k]).length, `${a.id} missing ${k}`);
    }
    assert.ok(Array.isArray(a.traits) && a.traits.length >= 2, `${a.id} traits`);
    assert.ok(a.voice.edge, `${a.id} edge voice`);
  }
});

test('guardrails forbid explicit content and harm, and use the name token', () => {
  assert.match(GUARDRAILS, /\{userName\}/);
  assert.match(GUARDRAILS, /sexually explicit/i);
  assert.match(GUARDRAILS, /harm|hurt/i);
});

test('resolveArchetype falls back to the first archetype for unknown ids', () => {
  assert.equal(resolveArchetype('nova').id, 'nova');
  assert.equal(resolveArchetype('LYRA').id, 'lyra');
  assert.equal(resolveArchetype('').id, 'lyra');
  assert.equal(resolveArchetype('ghost').id, 'lyra');
});

test('resolveArchetype merges overrides shallowly, including voice', () => {
  const r = resolveArchetype('nova', { nova: { name: 'Nyx', voice: { edge: 'en-GB-LibbyNeural' } } });
  assert.equal(r.name, 'Nyx');
  assert.equal(r.voice.edge, 'en-GB-LibbyNeural');
  assert.equal(r.voice.elevenlabs, ARCHETYPES.find(a => a.id === 'nova').voice.elevenlabs);
});

test('pickVoice prefers the archetype voice, then env default', () => {
  const a = resolveArchetype('kira');
  assert.equal(pickVoice(a, 'edge'), a.voice.edge);
  const noEleven = { ...a, voice: { ...a.voice, elevenlabs: '' } };
  assert.equal(pickVoice(noEleven, 'elevenlabs', { elevenlabs: 'ENVID' }), 'ENVID');
});
