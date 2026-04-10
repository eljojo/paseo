import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { Dimensions, Platform, Text, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { ExternalLink, Globe, LoaderCircle, Play, SquareTerminal } from "lucide-react-native";
import { GitHubIcon } from "@/components/icons/github-icon";
import { DiffStat } from "@/components/diff-stat";
import { Pressable } from "react-native";
import { Portal } from "@gorhom/portal";
import { useBottomSheetModalInternal } from "@gorhom/bottom-sheet";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { PrHint } from "@/hooks/use-checkout-pr-status-query";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { openExternalUrl } from "@/utils/open-external-url";
import { navigateToPreparedWorkspaceTab } from "@/utils/workspace-navigation";
import { PrBadge } from "@/components/sidebar-workspace-list";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

function computeHoverCardPosition({
  triggerRect,
  contentSize,
  displayArea,
  offset,
}: {
  triggerRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  offset: number;
}): { x: number; y: number } {
  let x = triggerRect.x + triggerRect.width + offset;
  let y = triggerRect.y;

  // If it overflows right, try left
  if (x + contentSize.width > displayArea.width - 8) {
    x = triggerRect.x - contentSize.width - offset;
  }

  // Constrain to screen
  const padding = 8;
  x = Math.max(padding, Math.min(displayArea.width - contentSize.width - padding, x));
  y = Math.max(
    displayArea.y + padding,
    Math.min(displayArea.y + displayArea.height - contentSize.height - padding, y),
  );

  return { x, y };
}

const HOVER_GRACE_MS = 100;
const HOVER_CARD_WIDTH = 260;

interface WorkspaceHoverCardProps {
  workspace: SidebarWorkspaceEntry;
  prHint: PrHint | null;
  isDragging: boolean;
}

export function WorkspaceHoverCard({
  workspace,
  prHint,
  isDragging,
  children,
}: PropsWithChildren<WorkspaceHoverCardProps>): ReactElement {
  // Desktop-only: skip on non-web platforms
  if (Platform.OS !== "web") {
    return <>{children}</>;
  }

  return (
    <WorkspaceHoverCardDesktop workspace={workspace} prHint={prHint} isDragging={isDragging}>
      {children}
    </WorkspaceHoverCardDesktop>
  );
}

function WorkspaceHoverCardDesktop({
  workspace,
  prHint,
  isDragging,
  children,
}: PropsWithChildren<WorkspaceHoverCardProps>): ReactElement {
  const triggerRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerHoveredRef = useRef(false);
  const contentHoveredRef = useRef(false);

  const hasScripts = workspace.scripts.length > 0;
  const hasContent = hasScripts || prHint !== null;

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    clearGraceTimer();
    graceTimerRef.current = setTimeout(() => {
      if (!triggerHoveredRef.current && !contentHoveredRef.current) {
        setOpen(false);
      }
      graceTimerRef.current = null;
    }, HOVER_GRACE_MS);
  }, [clearGraceTimer]);

  const handleTriggerEnter = useCallback(() => {
    triggerHoveredRef.current = true;
    clearGraceTimer();
    if (!isDragging && hasContent) {
      setOpen(true);
    }
  }, [clearGraceTimer, isDragging, hasContent]);

  const handleTriggerLeave = useCallback(() => {
    triggerHoveredRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  const handleContentEnter = useCallback(() => {
    contentHoveredRef.current = true;
    clearGraceTimer();
  }, [clearGraceTimer]);

  const handleContentLeave = useCallback(() => {
    contentHoveredRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  // Close when drag starts
  useEffect(() => {
    if (isDragging) {
      clearGraceTimer();
      setOpen(false);
    }
  }, [isDragging, clearGraceTimer]);

  // When content becomes available while trigger is already hovered, open the card.
  useEffect(() => {
    if (!hasContent || isDragging) return;
    if (triggerHoveredRef.current) {
      setOpen(true);
    }
  }, [hasContent, isDragging]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearGraceTimer();
    };
  }, [clearGraceTimer]);

  return (
    <View
      ref={triggerRef}
      collapsable={false}
      onPointerEnter={handleTriggerEnter}
      onPointerLeave={handleTriggerLeave}
    >
      {children}
      {open && hasContent ? (
        <WorkspaceHoverCardContent
          workspace={workspace}
          prHint={prHint}
          triggerRef={triggerRef}
          onContentEnter={handleContentEnter}
          onContentLeave={handleContentLeave}
        />
      ) : null}
    </View>
  );
}

function getScriptHealthColor(input: {
  health: SidebarWorkspaceEntry["scripts"][number]["health"];
  theme: ReturnType<typeof useUnistyles>["theme"];
}): string {
  if (input.health === "healthy") {
    return input.theme.colors.palette.blue[500];
  }
  if (input.health === "unhealthy") {
    return input.theme.colors.palette.red[500];
  }
  return input.theme.colors.foregroundMuted;
}

function getScriptHealthLabel(
  health: SidebarWorkspaceEntry["scripts"][number]["health"],
): "Healthy" | "Unhealthy" | "Unknown" {
  if (health === "healthy") {
    return "Healthy";
  }
  if (health === "unhealthy") {
    return "Unhealthy";
  }
  return "Unknown";
}


function WorkspaceHoverCardContent({
  workspace,
  prHint,
  triggerRef,
  onContentEnter,
  onContentLeave,
}: {
  workspace: SidebarWorkspaceEntry;
  prHint: PrHint | null;
  triggerRef: React.RefObject<View | null>;
  onContentEnter: () => void;
  onContentLeave: () => void;
}): ReactElement | null {
  const { theme } = useUnistyles();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[workspace.serverId]?.client ?? null);
  const bottomSheetInternal = useBottomSheetModalInternal(true);
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const startScriptMutation = useMutation({
    mutationFn: async (scriptName: string) => {
      if (!client) {
        throw new Error("Daemon client not available");
      }
      const result = await client.startWorkspaceScript(workspace.workspaceId, scriptName);
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    },
    onSuccess: (data) => {
      if (data.terminalId) {
        navigateToPreparedWorkspaceTab({
          serverId: workspace.serverId,
          workspaceId: workspace.workspaceId,
          target: { kind: "terminal", terminalId: data.terminalId },
        });
      }
    },
    onError: (error, scriptName) => {
      toast.show(
        error instanceof Error ? error.message : `Failed to start ${scriptName}`,
        { variant: "error" },
      );
    },
  });

  // Measure trigger — same pattern as tooltip.tsx
  useEffect(() => {
    if (!triggerRef.current) return;

    let cancelled = false;
    measureElement(triggerRef.current).then((rect) => {
      if (cancelled) return;
      setTriggerRect(rect);
    });

    return () => {
      cancelled = true;
    };
  }, [triggerRef]);

  // Compute position when both measurements are available
  useEffect(() => {
    if (!triggerRect || !contentSize) return;
    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    const displayArea = { x: 0, y: 0, width: screenWidth, height: screenHeight };
    const result = computeHoverCardPosition({
      triggerRect,
      contentSize,
      displayArea,
      offset: 4,
    });
    setPosition(result);
  }, [triggerRect, contentSize]);

  const handleLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setContentSize({ width, height });
    },
    [],
  );

  return (
    <Portal hostName={bottomSheetInternal?.hostName}>
      <View pointerEvents="box-none" style={styles.portalOverlay}>
        <Animated.View
          entering={FadeIn.duration(80)}
          exiting={FadeOut.duration(80)}
          collapsable={false}
          onLayout={handleLayout}
          onPointerEnter={onContentEnter}
          onPointerLeave={onContentLeave}
          accessibilityRole="menu"
          accessibilityLabel="Workspace scripts"
          testID="workspace-hover-card"
          style={[
            styles.card,
            {
              width: HOVER_CARD_WIDTH,
              position: "absolute",
              top: position?.y ?? -9999,
              left: position?.x ?? -9999,
            },
          ]}
        >
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle} numberOfLines={1} testID="hover-card-workspace-name">
              {workspace.name}
            </Text>
          </View>
          {prHint || workspace.diffStat ? (
            <View style={styles.cardMetaRow}>
              {workspace.diffStat ? (
                <DiffStat
                  additions={workspace.diffStat.additions}
                  deletions={workspace.diffStat.deletions}
                />
              ) : null}
              {prHint ? <PrBadge hint={prHint} /> : null}
            </View>
          ) : null}
          {workspace.scripts.length > 0 ? (
            <>
              <View style={styles.separator} />
              <View style={styles.sectionLabelRow}>
                <Play size={12} color={theme.colors.foregroundMuted} fill="transparent" />
                <Text style={styles.sectionLabel}>Scripts</Text>
              </View>
              <View style={styles.sectionList} testID="hover-card-script-list">
                {workspace.scripts.map((script) => {
                  const isRunning = script.lifecycle === "running";
                  const isService = (script.type ?? "service") === "service";
                  const isLinkable = isService && isRunning && !!script.url;
                  const exitCode = script.exitCode ?? null;

                  let dotColor: string;
                  if (isService) {
                    dotColor = isRunning
                      ? getScriptHealthColor({ health: script.health, theme })
                      : theme.colors.foregroundMuted;
                  } else if (isRunning) {
                    dotColor = theme.colors.palette.blue[500];
                  } else if (exitCode === 0) {
                    dotColor = theme.colors.palette.green[500];
                  } else if (exitCode !== null) {
                    dotColor = theme.colors.palette.red[500];
                  } else {
                    dotColor = theme.colors.foregroundMuted;
                  }

                  let accessibilityStatus: string;
                  if (isService) {
                    accessibilityStatus = isRunning ? getScriptHealthLabel(script.health) : "Stopped";
                  } else if (isRunning) {
                    accessibilityStatus = "Running";
                  } else if (exitCode === 0) {
                    accessibilityStatus = "Completed";
                  } else if (exitCode !== null) {
                    accessibilityStatus = `Failed (exit ${exitCode})`;
                  } else {
                    accessibilityStatus = "Stopped";
                  }

                  return (
                    <Pressable
                      key={script.hostname}
                      accessibilityRole={isLinkable ? "link" : undefined}
                      accessibilityLabel={`${script.scriptName} script — ${accessibilityStatus}`}
                      testID={`hover-card-script-${script.scriptName}`}
                      style={({ hovered }) => [
                        styles.listRow,
                        hovered && isLinkable && styles.listRowHovered,
                      ]}
                      onPress={isLinkable ? () => void openExternalUrl(script.url!) : undefined}
                      disabled={!isLinkable}
                    >
                      {({ hovered }) => (
                        <>
                          {isService ? (
                            <Globe
                              size={14}
                              color={dotColor}
                              testID={`hover-card-script-health-${script.scriptName}`}
                              style={styles.scriptIcon}
                            />
                          ) : (
                            <SquareTerminal
                              size={14}
                              color={dotColor}
                              testID={`hover-card-script-health-${script.scriptName}`}
                              style={styles.scriptIcon}
                            />
                          )}
                          <Text
                            style={[
                              styles.listRowLabel,
                              {
                                color: isRunning
                                  ? theme.colors.foreground
                                  : theme.colors.foregroundMuted,
                              },
                            ]}
                            numberOfLines={1}
                          >
                            {script.scriptName}
                          </Text>
                          {isService && isRunning && script.url ? (
                            <Text style={styles.listRowSecondary} numberOfLines={1}>
                              {script.url.replace(/^https?:\/\//, "")}
                            </Text>
                          ) : !isService && !isRunning && exitCode !== null && exitCode !== 0 ? (
                            <Text style={styles.listRowSecondary} numberOfLines={1}>
                              exit {exitCode}
                            </Text>
                          ) : (
                            <View style={styles.listRowSpacer} />
                          )}
                          {isRunning ? (
                            isLinkable && hovered ? (
                              <View
                                style={[
                                  styles.externalLinkOverlay,
                                  {
                                    backgroundImage: `linear-gradient(to right, transparent, ${theme.colors.surface2} 40%)`,
                                  },
                                ]}
                              >
                                <ExternalLink
                                  size={12}
                                  color={theme.colors.foreground}
                                />
                              </View>
                            ) : null
                          ) : (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Run ${script.scriptName} script`}
                              testID={`hover-card-script-start-${script.scriptName}`}
                              hitSlop={4}
                              disabled={startScriptMutation.isPending}
                              onPress={(event) => {
                                event.stopPropagation();
                                startScriptMutation.mutate(script.scriptName);
                              }}
                              style={styles.startButton}
                            >
                              {({ hovered: actionHovered }) =>
                                startScriptMutation.isPending &&
                                startScriptMutation.variables === script.scriptName ? (
                                  <LoaderCircle size={12} color={theme.colors.foregroundMuted} />
                                ) : (
                                  <>
                                    <Play
                                      size={10}
                                      color={actionHovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                                      fill="transparent"
                                    />
                                    <Text
                                      style={[
                                        styles.startButtonLabel,
                                        {
                                          color: actionHovered
                                            ? theme.colors.foreground
                                            : theme.colors.foregroundMuted,
                                        },
                                      ]}
                                    >
                                      Run
                                    </Text>
                                  </>
                                )
                              }
                            </Pressable>
                          )}
                        </>
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}
          {prHint?.checks && prHint.checks.length > 0 ? (
            <>
              <View style={styles.separator} />
              <Pressable
                style={({ hovered }) => [
                  styles.checksSummaryRow,
                  hovered && styles.listRowHovered,
                ]}
                onPress={() => void openExternalUrl(`${prHint.url}/checks`)}
              >
                {({ hovered }) => {
                  const checks = prHint.checks!;
                  const failed = checks.filter((c) => c.status === "failure").length;
                  const pending = checks.filter((c) => c.status === "pending").length;

                  let badgeColor: string;
                  let badgeLabel: string;

                  if (failed > 0) {
                    badgeColor = theme.colors.palette.red[500];
                    badgeLabel = `${failed} failed`;
                  } else if (pending > 0) {
                    badgeColor = theme.colors.palette.amber[500];
                    badgeLabel = `${pending} running`;
                  } else {
                    badgeColor = theme.colors.palette.green[500];
                    badgeLabel = `${checks.length} passed`;
                  }

                  return (
                    <>
                      <GitHubIcon size={12} color={theme.colors.foregroundMuted} />
                      <Text style={styles.checksSummaryLabel}>Checks</Text>
                      <View style={styles.checksSummaryCounts}>
                        <View style={[styles.checksDot, { backgroundColor: badgeColor }]} />
                        <Text style={[styles.checksStatusText, { color: badgeColor }]}>
                          {badgeLabel}
                        </Text>
                      </View>
                      {hovered ? (
                        <View
                          style={[
                            styles.externalLinkOverlay,
                            {
                              backgroundImage: `linear-gradient(to right, transparent, ${theme.colors.surface2} 40%)`,
                            },
                          ]}
                        >
                          <ExternalLink
                            size={12}
                            color={theme.colors.foreground}
                          />
                        </View>
                      ) : null}
                    </>
                  );
                }}
              </Pressable>
            </>
          ) : null}
        </Animated.View>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create((theme) => ({
  portalOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1000,
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    paddingTop: theme.spacing[2],
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 1000,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    flex: 1,
    minWidth: 0,
  },
  cardMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  separator: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  sectionLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  sectionList: {
    paddingBottom: theme.spacing[1],
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    minHeight: 28,
  },
  listRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  externalLinkOverlay: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  listRowLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    lineHeight: 18,
    flexShrink: 0,
  },
  listRowSecondary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    flex: 1,
    minWidth: 0,
    textAlign: "right",
  },
  listRowSpacer: {
    flex: 1,
    minWidth: 0,
  },
  scriptIcon: {
    flexShrink: 0,
  },
  checksSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 6,
    minHeight: 28,
  },
  checksSummaryLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  checksSummaryCounts: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flex: 1,
    justifyContent: "flex-end",
  },
  checksDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  checksStatusText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  startButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  startButtonLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
}));
