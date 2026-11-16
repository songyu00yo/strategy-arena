import LegacyArenaPage from "@/components/planning/LegacyArenaPage";
import { PlanningPage } from "@/components/planning/PlanningPage";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  if (query.arena !== undefined || query.legacy !== undefined || query.examples !== undefined)
    return <LegacyArenaPage />;
  return <PlanningPage />;
}
