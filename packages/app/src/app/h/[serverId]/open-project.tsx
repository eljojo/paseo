import { useLocalSearchParams } from "expo-router";
import { OpenProjectScreen } from "@/screens/open-project-screen";

export default function HostOpenProjectRoute() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";

  return <OpenProjectScreen serverId={serverId} />;
}
