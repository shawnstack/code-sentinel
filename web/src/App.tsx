import { Routes, Route, Navigate } from 'react-router'
import Projects from './pages/Projects'
import ProjectLayout from './pages/ProjectLayout'
import ScanList from './pages/ScanList'
import Review from './pages/Review'
import Rules from './pages/Rules'
import Fixes from './pages/Fixes'
import FileViewer from './pages/FileViewer'
import Settings from './pages/Settings'
import ScanConfigPage from './pages/ScanConfig'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Projects />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/p/:id" element={<ProjectLayout />}>
        <Route index element={<ScanList />} />
        <Route path="scan/:scanId" element={<Review />} />
        <Route path="rules" element={<Rules />} />
        <Route path="fixes" element={<Fixes />} />
        <Route path="files" element={<FileViewer />} />
        <Route path="config" element={<ScanConfigPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
