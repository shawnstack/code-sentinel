/** 解析 git unified diff 输出为结构化数据（前端 diff 视图与扫描引擎共用） */

export type LineType = 'add' | 'del' | 'context' | 'meta'

export interface DiffLine {
  type: LineType
  oldLine: number | null
  newLine: number | null
  content: string
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  oldPath: string
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  hunks: DiffHunk[]
  additions: number
  deletions: number
  isBinary: boolean
  exempt?: boolean        // 豁免：显示 diff 但不做规则触发 / 不调 AI
  exemptReason?: string   // 豁免原因（白名单 / 超出文件数上限）
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let oldLine = 0
  let newLine = 0

  const newFile = (): DiffFile => ({
    path: '',
    oldPath: '',
    status: 'modified',
    hunks: [],
    additions: 0,
    deletions: 0,
    isBinary: false
  })

  for (const raw of text.split('\n')) {
    const dg = raw.match(/^diff --git a\/(.*) b\/(.*)$/)
    if (dg) {
      cur = newFile()
      cur.path = dg[2]
      cur.oldPath = dg[1]
      files.push(cur)
      hunk = null
      continue
    }
    if (!cur) continue

    if (raw.startsWith('new file mode')) {
      cur.status = 'added'
      continue
    }
    if (raw.startsWith('deleted file mode')) {
      cur.status = 'deleted'
      continue
    }
    if (raw.startsWith('rename from ')) {
      cur.status = 'renamed'
      cur.oldPath = raw.slice('rename from '.length)
      continue
    }
    if (raw.startsWith('rename to ')) {
      cur.path = raw.slice('rename to '.length)
      continue
    }
    if (raw.startsWith('Binary files')) {
      cur.isBinary = true
      continue
    }
    if (raw.startsWith('GIT binary patch')) {
      cur.isBinary = true
      continue
    }

    const hm = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (hm) {
      hunk = {
        header: raw,
        oldStart: Number(hm[1]),
        oldCount: hm[2] ? Number(hm[2]) : 1,
        newStart: hm[3] ? Number(hm[3]) : 1,
        newCount: hm[4] ? Number(hm[4]) : 1,
        lines: []
      }
      cur.hunks.push(hunk)
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      continue
    }
    if (!hunk) continue

    if (raw.startsWith('+')) {
      hunk.lines.push({ type: 'add', oldLine: null, newLine: newLine++, content: raw.slice(1) })
      cur.additions++
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ type: 'del', oldLine: oldLine++, newLine: null, content: raw.slice(1) })
      cur.deletions++
    } else if (raw.startsWith(' ')) {
      hunk.lines.push({ type: 'context', oldLine: oldLine++, newLine: newLine++, content: raw.slice(1) })
    } else if (raw.startsWith('\\')) {
      hunk.lines.push({ type: 'meta', oldLine: null, newLine: null, content: raw.slice(1) })
    }
  }
  return files
}

/** 提取某个文件 diff 中所有新增行号（用于触发器符号匹配） */
export function addedLinesOf(df: DiffFile): { line: number; content: string }[] {
  const out: { line: number; content: string }[] = []
  for (const h of df.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add' && l.newLine != null) {
        out.push({ line: l.newLine, content: l.content })
      }
    }
  }
  return out
}
