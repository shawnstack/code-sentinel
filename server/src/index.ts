import express from 'express'
import { PORT } from './config.js'
import { api, mountStatic } from './routes.js'

const app = express()
app.use('/api', api)
mountStatic(app)

app.listen(PORT, () => {
  console.log(`Code Sentinel server 已启动: http://localhost:${PORT}`)
  console.log(`开发模式请配合 web (vite 5174) 使用；生产模式直接访问上方地址`)
})
