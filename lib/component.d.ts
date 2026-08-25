/**
 * Native Custom Elements (Web Component) wrapper for dsh-interactive-shell.
 *
 * Provides a framework-agnostic `<dsh-shell-dock>` element with Shadow DOM
 * encapsulation, reactive attribute observation, and custom event dispatches.
 *
 * Isomorphic & SSR-safe: does not crash when imported in Node.js / headless environments.
 *
 * @module
 */
import { DshShellPanelController } from './ui.js';
/** Universal base class for SSR / Node.js headless compatibility. */
declare const BaseElement: typeof HTMLElement;
/**
 * Standard Web Component for the interactive shell floating dock.
 */
export declare class DshShellDockElement extends BaseElement {
    static get observedAttributes(): string[];
    private root?;
    private controller;
    private unsubscribe?;
    constructor();
    /** Expose underlying panel controller for advanced programmatic control. */
    get panelController(): DshShellPanelController;
    connectedCallback(): void;
    disconnectedCallback(): void;
    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void;
    /** Render styles and HTML into Shadow Root. */
    render(): void;
    private handleClick;
}
/**
 * Register the <dsh-shell-dock> Custom Element globally if in browser environment.
 */
export declare function defineDshShellComponent(tagName?: string): void;
export {};
