import { TopBar } from "@/components/layout/TopBar";
import { DashboardStats } from "@/features/dashboard/components/StatCard";

export default function DashboardPage() {
  return (
    <div className="flex flex-col h-full">
      <TopBar title="Dashboard" />
      <div className="flex-1 p-6">
        <DashboardStats />
      </div>
    </div>
  );
}
