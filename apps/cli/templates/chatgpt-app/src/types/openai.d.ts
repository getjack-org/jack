/**
 * TypeScript definitions for the ChatGPT Widget API
 * This interface is injected by ChatGPT when rendering widgets
 */

export interface WidgetState {
  [key: string]: unknown;
}

export interface OpenAIWidget {
  /**
   * Send a message to ChatGPT from the widget
   */
  sendMessage: (message: string) => void;

  /**
   * Register a callback for messages from ChatGPT
   */
  onMessage: (callback: (message: string) => void) => void;

  /**
   * Send tool output back to ChatGPT
   */
  toolOutput: (output: unknown) => void;

  /**
   * Get the current widget state
   */
  widgetState: WidgetState;

  /**
   * Update the widget state
   */
  setWidgetState: (state: WidgetState) => void;

  /**
   * Call a tool defined in your MCP server
   */
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

  /**
   * Current theme: 'light' or 'dark'
   */
  theme: "light" | "dark";

  /**
   * Display mode of the widget
   */
  displayMode: "inline" | "popup" | "fullscreen";
}

declare global {
  interface Window {
    openai?: OpenAIWidget;
  }
}

export {};
