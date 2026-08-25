/**
 * Intelligent CLI Prompts Parser, Menu Extractor, and Auto-Responder.
 *
 * Automatically detects interactive CLI prompts (Confirmation, Secret/Password,
 * Text Input, Single-Select Radio Menus, Multi-Select Menus) and suggests
 * or automates responses to avoid trial-and-error token waste.
 *
 * @module
 */

import { stripAnsi } from './client.js'

export type PromptKind = 'confirm' | 'text_input' | 'secret_input' | 'select_menu' | 'multi_select' | 'numbered_menu'

export interface PromptChoice {
  index: number
  label: string
  value: string
  selected: boolean
  highlighted: boolean
}

export interface ParsedPrompt {
  kind: PromptKind
  message: string
  defaultValue?: string
  choices?: PromptChoice[]
  highlightedIndex?: number
  rawPromptLine: string
}

/** Pre-compiled prompt regex patterns. */
const CONFIRM_PATTERN = /^(.*?)\s*(\([yY]\/[nN]\)|\[[yY]\/[nN]\]|\([yYnN]\)|\([yY]es\/[nN]o\)|\([yY]\/[nN]\/[cC]\))\s*[:?]?\s*$/i
const SECRET_PATTERN = /(?:password|passphrase|secret|token|api key)\s*[:?]\s*$/i
const TEXT_INPUT_PATTERN = /^(?:[?❯>]\s*)?([^:\n?]+?)\s*[:?]\s*(?:\(([^)]+)\))?\s*$/
const NUMBERED_CHOICE_PATTERN = /^(?:\[?(\d+)\]?[.)]\s+|\s*(\d+)\)\s+)(.+)$/
const NUMBERED_PROMPT_LINE = /(?:enter (?:number|selection|choice)|select|choose)\s*(?:\[|\()?(\d+)[-~](\d+)(?:\]|\))?\s*[:?]\s*$/i

/**
 * Parse the latest active interactive CLI prompt from terminal plain text.
 */
export function parseInteractivePrompt(terminalText: string): ParsedPrompt | null {
  if (!terminalText) return null
  const clean = stripAnsi(terminalText).trimEnd()
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length === 0) return null

  const lastLine = lines[lines.length - 1].trim()

  // 1. Check Confirmation: "Are you sure? (y/N)" or "Overwrite? [Y/n]"
  const confirmMatch = lastLine.match(CONFIRM_PATTERN)
  if (confirmMatch) {
    const hint = confirmMatch[2]
    const def = hint.includes('Y') ? 'y' : hint.includes('N') ? 'n' : undefined
    return {
      kind: 'confirm',
      message: confirmMatch[1].trim(),
      defaultValue: def,
      rawPromptLine: lastLine,
    }
  }

  // 2. Check Secret/Password Prompt: "Password:" / "Enter token:"
  if (SECRET_PATTERN.test(lastLine)) {
    return {
      kind: 'secret_input',
      message: lastLine.replace(/[:?]\s*$/, '').trim(),
      rawPromptLine: lastLine,
    }
  }

  // 3. Check Numbered Select Menu (e.g. 1) Production  2) Staging)
  const candidateWindow = lines.slice(-10)
  const numberedChoices: PromptChoice[] = []
  let numberedHeader = ''

  for (const line of candidateWindow) {
    const trimmed = line.trim()
    const match = trimmed.match(NUMBERED_CHOICE_PATTERN)
    if (match) {
      const numStr = match[1] || match[2]
      const label = match[3].trim()
      numberedChoices.push({
        index: Number.parseInt(numStr, 10),
        label,
        value: numStr,
        selected: false,
        highlighted: false,
      })
    } else if (numberedChoices.length === 0) {
      numberedHeader = trimmed
    }
  }

  if (numberedChoices.length >= 2 && (NUMBERED_PROMPT_LINE.test(lastLine) || lastLine.includes(':') || lastLine.includes('?'))) {
    const isPromptLine = NUMBERED_PROMPT_LINE.test(lastLine)
    return {
      kind: 'numbered_menu',
      message: numberedHeader || (isPromptLine ? lastLine : 'Choose an option:'),
      choices: numberedChoices,
      rawPromptLine: lastLine,
    }
  }

  // 4. Check Cursor/Checkbox Menu Selection (Inquirer / Bubbletea / Clack / Enquirer / prompts style)
  const menuLines = lines.slice(-8)
  const hasMenuIndicator = menuLines.some((l) => /^[❯>*●]\s+/.test(l.trim()) || /\[[ xX*]\]|\([ *]\)/.test(l))

  if (hasMenuIndicator) {
    const candidateChoices: PromptChoice[] = []
    let menuHeader = ''
    let isMultiSelect = false

    // Find header index: first line that ends with ':' or '?' or starts with '?'
    let headerIdx = -1
    for (let i = 0; i < menuLines.length; i++) {
      const line = menuLines[i].trim()
      if (line.startsWith('?') || line.endsWith(':') || line.includes('(Use arrow keys)')) {
        menuHeader = line
        headerIdx = i
        break
      }
    }

    const choiceLines = headerIdx >= 0 ? menuLines.slice(headerIdx + 1) : menuLines

    for (let i = 0; i < choiceLines.length; i++) {
      const line = choiceLines[i].trim()
      if (line.length === 0) continue

      const isHighlighted = /^[❯>*●]\s+/.test(line)
      const hasCheckbox = /\[[ xX*]\]|\([ *]\)/.test(line)

      if (hasCheckbox) isMultiSelect = true

      const cleanLabel = line
        .replace(/^[❯>*●]\s*/, '')
        .replace(/^\[[ xX*]\]\s*/, '')
        .replace(/^\([ *]\)\s*/, '')
        .trim()

      const isSelected = line.includes('[x]') || line.includes('[X]') || line.includes('(*)')

      if (cleanLabel.length > 0) {
        candidateChoices.push({
          index: candidateChoices.length,
          label: cleanLabel,
          value: cleanLabel,
          selected: isSelected,
          highlighted: isHighlighted,
        })
      }
    }

    if (candidateChoices.length >= 2) {
      const highlightedIdx = candidateChoices.findIndex((c) => c.highlighted)
      return {
        kind: isMultiSelect ? 'multi_select' : 'select_menu',
        message: menuHeader || 'Select an option:',
        choices: candidateChoices,
        highlightedIndex: highlightedIdx >= 0 ? highlightedIdx : 0,
        rawPromptLine: lastLine,
      }
    }
  }

  // 5. General Text Input: "? Project name: (my-app)"
  const textMatch = lastLine.match(TEXT_INPUT_PATTERN)
  if (textMatch && !lastLine.startsWith('http') && !lastLine.startsWith('/') && lastLine.length < 120) {
    return {
      kind: 'text_input',
      message: textMatch[1].trim(),
      defaultValue: textMatch[2]?.trim(),
      rawPromptLine: lastLine,
    }
  }

  return null
}

export interface AutoResponderOptions {
  /** Auto-confirm yes to confirmation prompts (default: false). */
  autoConfirm?: boolean
  /** Value mapping for exact or regex prompt questions. */
  answers?: Record<string, string>
  /** Preferred single choice label/value when encountering single-select or numbered menus. */
  preferredChoice?: string
  /** Preferred choice labels/values when encountering multi-select menus. */
  preferredChoices?: string[]
}

/**
 * Generate keystrokes to answer a detected interactive prompt.
 */
export function generatePromptAnswer(
  prompt: ParsedPrompt,
  options: AutoResponderOptions = {},
): string | null {
  // 1. Direct answer mapping
  if (options.answers) {
    for (const [key, answer] of Object.entries(options.answers)) {
      if (prompt.message.toLowerCase().includes(key.toLowerCase()) || prompt.rawPromptLine.includes(key)) {
        return answer.endsWith('\n') ? answer : `${answer}\n`
      }
    }
  }

  // 2. Auto-confirm handling
  if (prompt.kind === 'confirm' && options.autoConfirm) {
    return 'y\n'
  }

  // 3. Numbered menu choice selection (submits number digit + \n)
  if (prompt.kind === 'numbered_menu' && prompt.choices && options.preferredChoice) {
    const target = prompt.choices.find((c) =>
      c.label.toLowerCase().includes(options.preferredChoice!.toLowerCase()) ||
      c.value === options.preferredChoice,
    )
    if (target) {
      return `${target.value}\n`
    }
  }

  // 4. Single-select menu choice selection with arrow key simulation
  if (prompt.kind === 'select_menu' && prompt.choices && options.preferredChoice) {
    const targetIdx = prompt.choices.findIndex((c) =>
      c.label.toLowerCase().includes(options.preferredChoice!.toLowerCase()) ||
      c.value.toLowerCase().includes(options.preferredChoice!.toLowerCase()),
    )

    if (targetIdx >= 0) {
      const currentIdx = prompt.highlightedIndex ?? 0
      const steps = targetIdx - currentIdx
      if (steps === 0) {
        return '\n' // Already on target choice
      } else if (steps > 0) {
        // Down arrow '\x1B[B' * steps + enter '\n'
        return '\x1B[B'.repeat(steps) + '\n'
      } else {
        // Up arrow '\x1B[A' * abs(steps) + enter '\n'
        return '\x1B[A'.repeat(Math.abs(steps)) + '\n'
      }
    }
  }

  // 5. Multi-select menu choice selection (space toggle + arrows navigation + enter)
  if (prompt.kind === 'multi_select' && prompt.choices && options.preferredChoices && options.preferredChoices.length > 0) {
    const targetIndices = new Set<number>()
    for (const pref of options.preferredChoices) {
      const idx = prompt.choices.findIndex((c) =>
        c.label.toLowerCase().includes(pref.toLowerCase()) ||
        c.value.toLowerCase().includes(pref.toLowerCase()),
      )
      if (idx >= 0) targetIndices.add(idx)
    }

    if (targetIndices.size > 0) {
      let currentPos = prompt.highlightedIndex ?? 0
      let keys = ''
      for (let i = 0; i < prompt.choices.length; i++) {
        if (targetIndices.has(i)) {
          const steps = i - currentPos
          if (steps > 0) keys += '\x1B[B'.repeat(steps)
          else if (steps < 0) keys += '\x1B[A'.repeat(Math.abs(steps))
          currentPos = i
          keys += ' '
        }
      }
      return keys + '\n'
    }
  }

  // 6. Default value submission if available
  if (prompt.defaultValue && options.autoConfirm) {
    return `${prompt.defaultValue}\n`
  }

  return null
}
