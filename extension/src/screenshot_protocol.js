import { SCREENSHOT_CONTRACT } from '../../shared/screenshot_contract.js';

export const kDefaultScreenshotConfig = {
  maxWidth: SCREENSHOT_CONTRACT.width.default,
  maxHeight: SCREENSHOT_CONTRACT.height.default,
  jpegQuality: SCREENSHOT_CONTRACT.quality.default,
  maxBase64Chars: SCREENSHOT_CONTRACT.maxChars.default,
  desktopDelayMs: SCREENSHOT_CONTRACT.desktopDelayMs.default,
  maxAttempts: SCREENSHOT_CONTRACT.maxAttempts,
  downscaleFactor: SCREENSHOT_CONTRACT.downscaleFactor,
  minJpegQuality: SCREENSHOT_CONTRACT.quality.minEncode
};

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampNumber(value, min, max, fallback) {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function resolveScreenshotConfig(command, base = kDefaultScreenshotConfig) {
  return {
    maxWidth: clampInt(command?.max_width, SCREENSHOT_CONTRACT.width.min, SCREENSHOT_CONTRACT.width.max, base.maxWidth),
    maxHeight: clampInt(command?.max_height, SCREENSHOT_CONTRACT.height.min, SCREENSHOT_CONTRACT.height.max, base.maxHeight),
    jpegQuality: clampNumber(command?.quality, SCREENSHOT_CONTRACT.quality.min, SCREENSHOT_CONTRACT.quality.max, base.jpegQuality),
    maxBase64Chars: clampInt(command?.max_chars, SCREENSHOT_CONTRACT.maxChars.min, SCREENSHOT_CONTRACT.maxChars.max, base.maxBase64Chars),
    desktopDelayMs: clampInt(
      command?.desktop_delay_ms,
      SCREENSHOT_CONTRACT.desktopDelayMs.min,
      SCREENSHOT_CONTRACT.desktopDelayMs.max,
      base.desktopDelayMs
    ),
    encoding: SCREENSHOT_CONTRACT.encoding,
    maxAttempts: base.maxAttempts,
    downscaleFactor: base.downscaleFactor,
    minJpegQuality: base.minJpegQuality
  };
}
