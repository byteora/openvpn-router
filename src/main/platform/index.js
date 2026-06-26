import { windowsPlatform } from './windows.js'
import { darwinPlatform } from './darwin.js'
import { logger } from '../services/logger.js'

function select() {
  switch (process.platform) {
    case 'win32':
      return windowsPlatform
    case 'darwin':
      return darwinPlatform
    default:
      logger.warn('platform', `unsupported platform "${process.platform}"; defaulting to a no-op backend`)
      return darwinPlatform // closest POSIX behaviour; routing will be best-effort
  }
}

export const platform = select()
export const isSupportedPlatform = process.platform === 'win32' || process.platform === 'darwin'
