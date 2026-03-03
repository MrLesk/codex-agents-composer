import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ManagerProvider } from "./context/ManagerContext";
import { Layout } from "./pages/Layout";
import { SkillsPage } from "./pages/SkillsPage";
import { AgentPage } from "./pages/AgentPage";
import { SkillEditorPage } from "./pages/SkillEditorPage";

const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, Component: SkillsPage },
      { path: "agent/new", Component: AgentPage },
      { path: "agent/:agentId", Component: AgentPage },
      { path: "skill/new", Component: SkillEditorPage },
      { path: "skill/:skillKey", Component: SkillEditorPage },
      { path: "*", Component: () => <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return (
    <ManagerProvider>
      <RouterProvider router={router} />
    </ManagerProvider>
  );
}
