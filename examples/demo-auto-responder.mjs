/**
 * Example: Automated Interactive CLI Assistant using dsh-interactive-shell.
 *
 * Demonstrates how an AI agent or automated script can:
 * 1. Capture interactive prompts (confirmations, text inputs, password prompts, selection menus)
 * 2. Parse the prompt type and available choices
 * 3. Generate correct terminal keystrokes (arrows, space toggles, numeric inputs, answers)
 *
 * Usage: node examples/demo-auto-responder.mjs
 */

import { parseInteractivePrompt, generatePromptAnswer } from '../lib/index.js'

console.log('🤖 === dsh-interactive-shell Automated Responder Demo ===\n')

// Sample 1: Confirmation Prompt
const prompt1 = 'Do you want to proceed with installing 42 dependencies? (Y/n) '
const parsed1 = parseInteractivePrompt(prompt1)
console.log('1. Parsing Confirmation Prompt:')
console.log('   Input :', prompt1.trim())
console.log('   Parsed:', parsed1)
const answer1 = generatePromptAnswer(parsed1, { preferredChoice: 'y' })
console.log('   Answer keystrokes:', JSON.stringify(answer1), '\n')

// Sample 2: Single-Select Interactive Menu
const prompt2 = `
? Select a framework to initialize:
  Vue.js
> React
  Svelte
  Solid
`
const parsed2 = parseInteractivePrompt(prompt2)
console.log('2. Parsing Single-Select Menu:')
console.log('   Choices:', parsed2?.choices)
console.log('   Currently Selected:', parsed2?.choices[parsed2.cursorIndex])
const answer2 = generatePromptAnswer(parsed2, { preferredChoice: 'Svelte' })
console.log('   Target: "Svelte"')
console.log('   Generated navigation keys:', JSON.stringify(answer2), '(down arrow + Enter)\n')

// Sample 3: Numbered Selection Menu
const prompt3 = `
Please choose target deployment environment:
  1) Development
  2) Staging
  3) Production
Select [1-3]: `
const parsed3 = parseInteractivePrompt(prompt3)
console.log('3. Parsing Numbered Menu:')
console.log('   Choices:', parsed3?.choices)
const answer3 = generatePromptAnswer(parsed3, { preferredChoice: 'Staging' })
console.log('   Target: "Staging"')
console.log('   Generated answer keystrokes:', JSON.stringify(answer3), '\n')

// Sample 4: Multi-Select Checkboxes
const prompt4 = `
? Select features to enable:
 ( ) TypeScript
 (*) ESLint
 ( ) Prettier
 ( ) Tailwind CSS
`
const parsed4 = parseInteractivePrompt(prompt4)
console.log('4. Parsing Multi-Select Checkbox Menu:')
console.log('   Choices:', parsed4?.choices)
const answer4 = generatePromptAnswer(parsed4, { preferredChoices: ['TypeScript', 'Prettier'] })
console.log('   Targets: ["TypeScript", "Prettier"]')
console.log('   Generated toggle & navigation keystrokes:', JSON.stringify(answer4), '\n')

console.log('✅ Automated responder demo completed successfully!')
