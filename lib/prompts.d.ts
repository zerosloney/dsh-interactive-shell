/**
 * Intelligent CLI Prompts Parser, Menu Extractor, and Auto-Responder.
 *
 * Automatically detects interactive CLI prompts (Confirmation, Secret/Password,
 * Text Input, Single-Select Radio Menus, Multi-Select Menus) and suggests
 * or automates responses to avoid trial-and-error token waste.
 *
 * @module
 */
export type PromptKind = 'confirm' | 'text_input' | 'secret_input' | 'select_menu' | 'multi_select' | 'numbered_menu';
export interface PromptChoice {
    index: number;
    label: string;
    value: string;
    selected: boolean;
    highlighted: boolean;
}
export interface ParsedPrompt {
    kind: PromptKind;
    message: string;
    defaultValue?: string;
    choices?: PromptChoice[];
    highlightedIndex?: number;
    rawPromptLine: string;
}
/**
 * Parse the latest active interactive CLI prompt from terminal plain text.
 */
export declare function parseInteractivePrompt(terminalText: string): ParsedPrompt | null;
export interface AutoResponderOptions {
    /** Auto-confirm yes to confirmation prompts (default: false). */
    autoConfirm?: boolean;
    /** Value mapping for exact or regex prompt questions. */
    answers?: Record<string, string>;
    /** Preferred single choice label/value when encountering single-select or numbered menus. */
    preferredChoice?: string;
    /** Preferred choice labels/values when encountering multi-select menus. */
    preferredChoices?: string[];
}
/**
 * Generate keystrokes to answer a detected interactive prompt.
 */
export declare function generatePromptAnswer(prompt: ParsedPrompt, options?: AutoResponderOptions): string | null;
