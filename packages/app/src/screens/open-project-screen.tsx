import { useCallback, useMemo, useRef, useState } from "react";
import { View, Text, ScrollView } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { FolderOpen } from "lucide-react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { FormSelectTrigger } from "@/components/agent-form/agent-form-dropdowns";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeSession } from "@/runtime/host-runtime";
import {
  normalizeWorkspaceDescriptor,
  useSessionStore,
} from "@/stores/session-store";
import { buildHostWorkspaceRouteWithOpenIntent } from "@/utils/host-routes";
import { buildWorkingDirectorySuggestions } from "@/utils/working-directory-suggestions";

export function OpenProjectScreen({ serverId }: { serverId: string }) {
  const { theme } = useUnistyles();
  const toast = useToast();
  const { client, isConnected } = useHostRuntimeSession(serverId);
  const workspaces = useSessionStore((state) => state.sessions[serverId]?.workspaces);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);
  const [isDirectoryPickerOpen, setIsDirectoryPickerOpen] = useState(false);
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const directoryAnchorRef = useRef<View>(null);

  const recommendedPaths = useMemo(() => {
    if (!workspaces) {
      return [];
    }
    return Array.from(workspaces.values()).map((workspace) => workspace.projectRootPath || workspace.id);
  }, [workspaces]);

  const directorySuggestionsQuery = useQuery({
    queryKey: ["open-project-directory-suggestions", serverId, directoryQuery],
    queryFn: async () => {
      if (!client) {
        return [];
      }
      const result = await client.getDirectorySuggestions({
        query: directoryQuery,
        includeDirectories: true,
        includeFiles: false,
        limit: 30,
      });
      return result.entries?.flatMap((entry) =>
        entry.kind === "directory" ? [entry.path] : []
      ) ?? [];
    },
    enabled: Boolean(client) && isConnected,
    staleTime: 15_000,
    retry: false,
  });

  const directoryOptions = useMemo(
    () =>
      buildWorkingDirectorySuggestions({
        recommendedPaths,
        serverPaths: directorySuggestionsQuery.data ?? [],
        query: directoryQuery,
      }).map((path) => ({
        id: path,
        label: path,
        kind: "directory" as const,
      })),
    [directoryQuery, directorySuggestionsQuery.data, recommendedPaths]
  );

  const handleOpenProject = useCallback(async () => {
    const trimmedPath = selectedPath.trim();
    if (!trimmedPath) {
      toast.error("Choose a project directory");
      return;
    }
    if (!client) {
      toast.error("Host is not connected");
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = await client.openProject(trimmedPath);
      if (payload.error || !payload.workspace) {
        throw new Error(payload.error || "Failed to open project");
      }
      mergeWorkspaces(serverId, [normalizeWorkspaceDescriptor(payload.workspace)]);
      setHasHydratedWorkspaces(serverId, true);
      router.replace(
        buildHostWorkspaceRouteWithOpenIntent(serverId, payload.workspace.id, {
          kind: "draft",
          draftId: "new",
        }) as any
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to open project");
    } finally {
      setIsSubmitting(false);
    }
  }, [client, mergeWorkspaces, selectedPath, serverId, setHasHydratedWorkspaces, toast]);

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.eyebrow}>Workspace Registry</Text>
          <Text style={styles.title}>Open project</Text>
          <Text style={styles.subtitle}>
            Add a local folder to the sidebar, then land inside its workspace draft tab.
          </Text>

          <FormSelectTrigger
            controlRef={directoryAnchorRef}
            containerStyle={styles.selector}
            label="Project directory"
            value={selectedPath}
            placeholder="Choose a project directory"
            onPress={() => setIsDirectoryPickerOpen(true)}
            icon={<FolderOpen size={theme.iconSize.md} color={theme.colors.foregroundMuted} />}
            showLabel={false}
            valueEllipsizeMode="middle"
            testID="open-project-directory-trigger"
          />

          <View style={styles.actions}>
            <Button
              variant="default"
              onPress={() => void handleOpenProject()}
              disabled={isSubmitting || !isConnected}
              testID="open-project-submit"
            >
              {isSubmitting ? "Opening..." : "Open project"}
            </Button>
          </View>
        </View>
      </ScrollView>

      <Combobox
        options={directoryOptions}
        value={selectedPath}
        onSelect={setSelectedPath}
        onSearchQueryChange={setDirectoryQuery}
        searchPlaceholder="Search directories..."
        emptyText="No directories found"
        allowCustomValue
        customValuePrefix=""
        customValueKind="directory"
        optionsPosition="above-search"
        title="Project directory"
        open={isDirectoryPickerOpen}
        onOpenChange={setIsDirectoryPickerOpen}
        anchorRef={directoryAnchorRef}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  card: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 560,
    gap: theme.spacing[4],
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  eyebrow: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.semibold,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  selector: {
    minHeight: 64,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-start",
  },
}));
