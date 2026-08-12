import { createRoot } from "react-dom/client"

import "./index.css"
import {
  initialAppearanceMode,
  ThemeProvider,
} from "./components/theme-provider.tsx"
import App from "./App.tsx"

performance.mark("pmd:renderer-entry")
createRoot(document.getElementById("root")!).render(
  <ThemeProvider defaultTheme={initialAppearanceMode()}>
    <App />
  </ThemeProvider>
)
