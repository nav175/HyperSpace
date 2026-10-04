import { HyperspaceShell } from "@/components/shell/HyperspaceShell";
import { loadNodes, loadNodesMeta } from "@/lib/data/loadNodes";

export default async function Home() {
  const [nodes, meta] = await Promise.all([loadNodes(), loadNodesMeta()]);

  return (
    <HyperspaceShell
      nodes={nodes}
      datasetVersion={meta?.datasetVersion}
    />
  );
}
