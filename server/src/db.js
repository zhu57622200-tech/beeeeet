import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './schema.js'

export const DEFAULT_DB_PATH = '/var/lib/beeeeet-online/app.db'

export function openDb(dbPath = process.env.DB_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}
