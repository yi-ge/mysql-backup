export const backupConnection = (connection) => {
  const { charset } = connection
  // Existing installations may have saved the old template's three-byte charset.
  if (!charset || (typeof charset === 'string' && charset.toUpperCase() === 'UTF8_GENERAL_CI')) {
    return { ...connection, charset: 'UTF8MB4_GENERAL_CI' }
  }
  return connection
}
