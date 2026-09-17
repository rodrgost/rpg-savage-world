import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_NARRATOR_SYSTEM_PROMPT, NARRATOR_PROMPT_METADATA } from './narrator.prompt.js'

test('DEFAULT_NARRATOR_SYSTEM_PROMPT contém seções obrigatórias para o motor de jogo', () => {
  assert.ok(DEFAULT_NARRATOR_SYSTEM_PROMPT.length > 500, 'O prompt padrão deve ter conteúdo substantivo')
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /Hierarquia Canônica/i)
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /Esquema JSON de Saída/i)
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /"segments"/i)
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /"options"/i)
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /"npcs"/i)
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /"itemChanges"/i)
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /"statusChanges"/i)
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /"npcAttacks"/i)
  assert.match(DEFAULT_NARRATOR_SYSTEM_PROMPT, /chanceCheck/i)
})

test('NARRATOR_PROMPT_METADATA possui estrutura e campos esperados', () => {
  assert.equal(NARRATOR_PROMPT_METADATA.key, 'narrator')
  assert.equal(NARRATOR_PROMPT_METADATA.enabled, true)
  assert.equal(typeof NARRATOR_PROMPT_METADATA.name, 'string')
  assert.equal(typeof NARRATOR_PROMPT_METADATA.description, 'string')
  assert.ok(NARRATOR_PROMPT_METADATA.variables.length >= 3, 'Deve conter as variáveis de contexto')
})
