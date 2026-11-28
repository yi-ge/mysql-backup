export async function getObjectStorage (provided) {
  if (provided) return provided
  const { default: db } = await import('../db.js')
  await db.read()
  return db.data.config.setting.ObjectStorage
}
