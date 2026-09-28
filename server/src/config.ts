import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/** 服务端口（避开 noteflow 的 5178/5179） */
export const PORT = Number(process.env.PORT || 5180)

/** 数据目录 */
export const DATA_DIR = path.join(os.homedir(), '.code-sentinel')

/** SQLite 路径 */
export const DB_PATH = path.join(DATA_DIR, 'sentinel.sqlite3')

/** 目标项目内存放规则的目录（相对项目根） */
export const RULES_DIR = '.codescan/rules'

/** 前端构建产物（生产模式静态托管） */
export const WEB_DIST = path.resolve(import.meta.dirname, '../../web/dist')

export function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}
