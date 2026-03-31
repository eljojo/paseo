import { CheckCircle2, CircleAlert, SquareTerminal } from "lucide-react-native";
import { ScrollView, Text, View } from "react-native";
import invariant from "tiny-invariant";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Fonts } from "@/constants/theme";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { buildWorkspaceTabPersistenceKey } from "@/stores/workspace-tabs-store";
import { useWorkspaceSetupStore } from "@/stores/workspace-setup-store";

function useSetupPanelDescriptor(
  target: { kind: "setup"; workspaceId: string },
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const key = buildWorkspaceTabPersistenceKey({
    serverId: context.serverId,
    workspaceId: target.workspaceId,
  });
  const snapshot = useWorkspaceSetupStore((state) => (key ? state.snapshots[key] ?? null : null));

  if (snapshot?.status === "completed") {
    return {
      label: "Setup",
      subtitle: "Setup completed",
      titleState: "ready",
      icon: CheckCircle2,
      statusBucket: null,
    };
  }

  if (snapshot?.status === "failed") {
    return {
      label: "Setup",
      subtitle: "Setup failed",
      titleState: "ready",
      icon: CircleAlert,
      statusBucket: null,
    };
  }

  return {
    label: "Setup",
    subtitle: "Workspace setup",
    titleState: "ready",
    icon: SquareTerminal,
    statusBucket: snapshot?.status === "running" ? "running" : null,
  };
}

function formatCommandStatus(status: "running" | "completed" | "failed"): string {
  if (status === "running") {
    return "Running";
  }
  if (status === "completed") {
    return "Completed";
  }
  return "Failed";
}

function formatSetupStatus(status: "running" | "completed" | "failed" | null): string {
  if (status === "running") {
    return "Running";
  }
  if (status === "completed") {
    return "Completed";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Waiting for setup output";
}

function SetupPanel() {
  const { theme } = useUnistyles();
  const { serverId, target } = usePaneContext();
  invariant(target.kind === "setup", "SetupPanel requires setup target");

  const key = buildWorkspaceTabPersistenceKey({
    serverId,
    workspaceId: target.workspaceId,
  });
  const snapshot = useWorkspaceSetupStore((state) => (key ? state.snapshots[key] ?? null : null));

  const commands = snapshot?.detail.commands ?? [];
  const log = snapshot?.detail.log ?? "";
  const statusLabel = formatSetupStatus(snapshot?.status ?? null);
  const hasNoSetupCommands =
    snapshot?.status === "completed" && commands.length === 0 && log.trim().length === 0;

  return (
    <View style={styles.container} testID="workspace-setup-panel">
      <View
        style={styles.header}
        accessible
        accessibilityLabel={`Workspace setup status: ${statusLabel}`}
        testID="workspace-setup-status"
      >
        <Text style={styles.title}>Workspace setup</Text>
        <View
          style={[
            styles.statusBadge,
            snapshot?.status === "completed" && {
              backgroundColor: theme.colors.palette.green[100],
            },
            snapshot?.status === "failed" && {
              backgroundColor: theme.colors.palette.red[100],
            },
          ]}
        >
          <Text
            style={[
              styles.statusBadgeText,
              snapshot?.status === "completed" && {
                color: theme.colors.palette.green[600],
              },
              snapshot?.status === "failed" && {
                color: theme.colors.palette.red[600],
              },
            ]}
          >
            {statusLabel}
          </Text>
        </View>
      </View>

      {snapshot?.error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Setup error</Text>
          <Text selectable style={styles.errorBody}>
            {snapshot.error}
          </Text>
        </View>
      ) : null}

      {commands.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Commands</Text>
          <View style={styles.commandList}>
            {commands.map((command) => (
              <View key={`${command.index}:${command.command}`} style={styles.commandRow}>
                <Text style={styles.commandIndex}>{command.index}.</Text>
                <View style={styles.commandTextColumn}>
                  <Text selectable style={styles.commandText}>
                    {command.command}
                  </Text>
                  <Text style={styles.commandMeta}>
                    {formatCommandStatus(command.status)}
                    {typeof command.exitCode === "number" ? ` · exit ${command.exitCode}` : ""}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.sectionFill}>
        <Text style={styles.sectionTitle}>Log</Text>
        {hasNoSetupCommands ? (
          <View style={styles.emptyCard}>
            <Text
              style={styles.emptyText}
              accessible
              accessibilityLabel="No setup commands ran for this workspace"
            >
              No setup commands ran for this workspace.
            </Text>
          </View>
        ) : (
          <ScrollView
            style={styles.logContainer}
            contentContainerStyle={styles.logContent}
            showsVerticalScrollIndicator
            testID="workspace-setup-log"
            accessible
            accessibilityLabel="Workspace setup log"
          >
            <Text selectable style={styles.logText}>
              {log.trim().length > 0 ? log : "Waiting for setup output..."}
            </Text>
          </ScrollView>
        )}
      </View>
    </View>
  );
}

export const setupPanelRegistration: PanelRegistration<"setup"> = {
  kind: "setup",
  component: SetupPanel,
  useDescriptor: useSetupPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  statusBadge: {
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
  },
  statusBadgeText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  errorCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.palette.red[200],
    backgroundColor: theme.colors.palette.red[100],
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  errorTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.palette.red[800],
  },
  errorBody: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[800],
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionFill: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  commandList: {
    gap: theme.spacing[2],
  },
  commandRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  commandIndex: {
    width: 18,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  commandTextColumn: {
    flex: 1,
    gap: theme.spacing[1],
  },
  commandText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  commandMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  logContainer: {
    flex: 1,
    minHeight: 0,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  logContent: {
    padding: theme.spacing[3],
  },
  logText: {
    fontFamily: Fonts.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  emptyCard: {
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
