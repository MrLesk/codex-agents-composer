import { Outlet } from "react-router";
import { Sidebar } from "../components/Sidebar";
import { useManager } from "../context/ManagerContext";

export function Layout() {
  const { error } = useManager();

  return (
    <div className="h-screen bg-[#0b0b0b] text-gray-100 flex overflow-hidden font-sans">
      <Sidebar />
      <main className="flex-1 overflow-hidden flex flex-col">
        {error ? (
          <div className="px-6 py-2 text-sm bg-red-500/10 border-b border-red-500/30 text-red-300">
            {error}
          </div>
        ) : null}
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
