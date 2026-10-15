export interface View {
  /** Render into root; returns a cleanup function. */
  mount(root: HTMLElement): () => void;
  /** Re-fetch data and repaint (called on live `changed` events and polls). */
  refresh(): Promise<void>;
}
