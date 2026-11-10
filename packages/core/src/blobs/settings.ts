/** Limits on images (docs/40-plan/08-sandbox-browser-vision.md §4.4). */
export interface VisionSettings {
  /** Largest stored image; a larger one becomes a text placeholder. */
  maxImageKb: number;
  /** Images one tool result or one event may carry to the model. */
  maxImagesPerMessage: number;
  /** Stored images older than this are removed; 0 keeps them. */
  blobRetentionDays: number;
}

export const DEFAULT_VISION_SETTINGS: VisionSettings = { maxImageKb: 1536, maxImagesPerMessage: 4, blobRetentionDays: 30 };
