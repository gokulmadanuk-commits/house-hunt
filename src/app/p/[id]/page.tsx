import { notFound } from "next/navigation";
import Workspace from "@/components/Workspace";
import { clientConfig } from "@/lib/config";
import { getProperty } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const p = await getProperty((await params).id);
  if (!p) notFound();
  return <Workspace config={clientConfig()} initial={p} />;
}
