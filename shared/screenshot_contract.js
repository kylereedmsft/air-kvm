export const SCREENSHOT_CONTRACT = Object.freeze({
  width: Object.freeze({ min: 160, max: 1920, default: 960 }),
  height: Object.freeze({ min: 120, max: 1080, default: 540 }),
  quality: Object.freeze({ min: 0.3, max: 0.9, default: 0.55, minEncode: 0.45 }),
  maxChars: Object.freeze({ min: 20000, max: 200000, default: 90000 }),
  desktopDelayMs: Object.freeze({ min: 0, max: 5000, default: 350 }),
  encoding: 'bin',
  chunkSize: 160,
  maxAttempts: 4,
  downscaleFactor: 0.8
});
