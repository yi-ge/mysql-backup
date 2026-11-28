if (process.env.MYSQL_BACKUP_LEGACY === '1') {
  await import('./legacy-main.js')
} else {
  const { start } = await import('./workbench/app.js')
  await start()
}
