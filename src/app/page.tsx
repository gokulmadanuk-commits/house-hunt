import Board from "@/components/Board";
import { clientConfig } from "@/lib/config";
import { listProperties } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function Home() {
  return <Board config={clientConfig()} initial={await listProperties()} />;
}
