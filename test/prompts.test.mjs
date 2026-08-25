import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseInteractivePrompt,
  generatePromptAnswer,
} from '../lib/index.js'

test('parseInteractivePrompt: parses confirmation prompts and defaults', () => {
  const p1 = parseInteractivePrompt('Do you want to continue? (y/N)')
  assert.ok(p1)
  assert.equal(p1.kind, 'confirm')
  assert.equal(p1.defaultValue, 'n')
  assert.equal(p1.message, 'Do you want to continue?')

  const p2 = parseInteractivePrompt('Overwrite existing files? [Y/n]: ')
  assert.ok(p2)
  assert.equal(p2.kind, 'confirm')
  assert.equal(p2.defaultValue, 'y')

  const ans = generatePromptAnswer(p2, { autoConfirm: true })
  assert.equal(ans, 'y\n')
})

test('parseInteractivePrompt: parses password / secret input prompts', () => {
  const p1 = parseInteractivePrompt('Enter sudo password: ')
  assert.ok(p1)
  assert.equal(p1.kind, 'secret_input')
  assert.equal(p1.message, 'Enter sudo password')

  const ans = generatePromptAnswer(p1, { answers: { sudo: 'mypassword123' } })
  assert.equal(ans, 'mypassword123\n')
})

test('parseInteractivePrompt: parses text input prompts with default value', () => {
  const p = parseInteractivePrompt('? Project name: (my-dsh-project)')
  assert.ok(p)
  assert.equal(p.kind, 'text_input')
  assert.equal(p.message, 'Project name')
  assert.equal(p.defaultValue, 'my-dsh-project')

  const ans = generatePromptAnswer(p, { autoConfirm: true })
  assert.equal(ans, 'my-dsh-project\n')
})

test('parseInteractivePrompt: parses select menu options and calculates navigation keystrokes', () => {
  const menuOutput = `
? Select template:
❯ TypeScript
  JavaScript
  Python
`

  const p = parseInteractivePrompt(menuOutput)
  assert.ok(p)
  assert.equal(p.kind, 'select_menu')
  assert.equal(p.choices.length, 3)
  assert.equal(p.choices[0].label, 'TypeScript')
  assert.equal(p.choices[0].highlighted, true)
  assert.equal(p.choices[1].label, 'JavaScript')
  assert.equal(p.choices[2].label, 'Python')

  // Target 1: TypeScript (already highlighted -> just Enter)
  const ans1 = generatePromptAnswer(p, { preferredChoice: 'TypeScript' })
  assert.equal(ans1, '\n')

  // Target 2: Python (2 steps down -> 2 x down arrow + enter)
  const ans2 = generatePromptAnswer(p, { preferredChoice: 'Python' })
  assert.equal(ans2, '\x1B[B\x1B[B\n')
})

test('parseInteractivePrompt: parses numbered select menus and answers with choice number', () => {
  const numberedOutput = `
Select deployment environment:
  1) Production
  2) Staging
  3) Local Docker
Enter selection [1-3]:
`
  const p = parseInteractivePrompt(numberedOutput)
  assert.ok(p)
  assert.equal(p.kind, 'numbered_menu')
  assert.equal(p.choices.length, 3)
  assert.equal(p.choices[0].value, '1')
  assert.equal(p.choices[0].label, 'Production')
  assert.equal(p.choices[1].value, '2')
  assert.equal(p.choices[1].label, 'Staging')

  // Answer by label
  const ansByLabel = generatePromptAnswer(p, { preferredChoice: 'Staging' })
  assert.equal(ansByLabel, '2\n')

  // Answer by number
  const ansByNum = generatePromptAnswer(p, { preferredChoice: '1' })
  assert.equal(ansByNum, '1\n')
})

test('parseInteractivePrompt: multi-select keystrokes generator with space toggle and navigation', () => {
  const multiMenu = `
? Pick features:
[ ] TypeScript
[ ] ESLint
[ ] Prettier
`
  const p = parseInteractivePrompt(multiMenu)
  assert.ok(p)
  assert.equal(p.kind, 'multi_select')

  // Pick TypeScript (index 0) and Prettier (index 2)
  const keys = generatePromptAnswer(p, { preferredChoices: ['TypeScript', 'Prettier'] })
  assert.equal(keys, ' \x1B[B\x1B[B \n')
})

test('parseInteractivePrompt: single-select menu upwards arrow navigation', () => {
  const menuOutput = `
? Select template:
  TypeScript
  JavaScript
❯ Python
`
  const p = parseInteractivePrompt(menuOutput)
  assert.ok(p)
  assert.equal(p.highlightedIndex, 2)

  // Navigate up to TypeScript (index 0)
  const keys = generatePromptAnswer(p, { preferredChoice: 'TypeScript' })
  assert.equal(keys, '\x1B[A\x1B[A\n')
})

test('parseInteractivePrompt: extended confirmation patterns (yes/no, y/n/c)', () => {
  const p1 = parseInteractivePrompt('Proceed with installation? (yes/no)')
  assert.ok(p1)
  assert.equal(p1.kind, 'confirm')

  const p2 = parseInteractivePrompt('Save changes? (y/n/c):')
  assert.ok(p2)
  assert.equal(p2.kind, 'confirm')
})

test('parseInteractivePrompt: returns null for plain non-interactive output', () => {
  assert.equal(parseInteractivePrompt('Building project... done in 2.3s\n'), null)
  assert.equal(parseInteractivePrompt(''), null)
})
