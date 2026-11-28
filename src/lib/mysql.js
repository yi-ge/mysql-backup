import { randomBytes } from 'node:crypto'

// Leave an existing SQL terminator intact. A delimiter starting in ';' can
// consume part of the original trigger when the server preserves its semicolon.
export const backupTriggerOptions = () => ({ delimiter: '$' + randomBytes(6).toString('hex') + '$' })

export const backupConnection = (connection) => {
  const { charset } = connection
  // Existing installations may have saved the old template's three-byte charset.
  if (!charset || (typeof charset === 'string' && charset.toUpperCase() === 'UTF8_GENERAL_CI')) {
    return { ...connection, charset: 'UTF8MB4_GENERAL_CI' }
  }
  return connection
}
